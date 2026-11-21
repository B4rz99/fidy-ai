import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Result, type Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";
import { nativeIngressHost, nativeWebHost } from "./storage-installation";
import {
  inspectDeployedEdge,
  requireClosedIngressDomains,
  requireStagedHostDomains,
} from "./native-deployed-edge";

type DomainAttachment = Readonly<{
  hostname: string;
  service: string;
  zone_id: string;
  enabled: boolean;
  previews_enabled: boolean;
}>;

const account = "a".repeat(32);

const zone = {
  id: "b".repeat(32),
  name: "fidyapp.com",
  status: "active",
  account: { id: account },
};

const scripts = ["fidy-web", "fidycloudflare-core-old", "fidycloudflare-ingress-old"].map(
  (id, index) => ({ id, tag: String(index + 1).repeat(32) })
);

const triggers = scripts.map(
  ({ tag }) => "/client/v4/accounts/" + account + "/builds/workers/" + tag + "/triggers"
);

const resultFor = (path: string): Schema.Json => {
  if (path === "/client/v4/zones") return [zone];

  if (path.endsWith("/workers/scripts")) return scripts;

  if (path.endsWith("/access/identity_providers")) {
    return [{ id: "eede7c92-1e53-42f1-865a-deaaf2d48de7", name: "PIN", type: "onetimepin" }];
  }

  return [];
};

type EdgeInspection = {
  seen: string[];
  operation: ReturnType<typeof inspectDeployedEdge>;
};

const inspect = (secret: string, buildResult: readonly unknown[] = []): EdgeInspection => {
  const seen: string[] = [];

  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    expect(url.origin).toBe("https://api.cloudflare.com");
    const builds = triggers.includes(url.pathname);

    if (builds) seen.push(url.pathname);
    expect(request.headers.authorization).toBe(
      builds ? "Bearer fixture-builds" : "Bearer fixture-release"
    );
    const result = url.pathname === triggers[0] ? buildResult : resultFor(url.pathname);

    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json({ success: true, result }))
    );
  });

  const operation = inspectDeployedEdge({ account, token: "fixture-release" }, client, {
    installed: false,
    hosts: "acceptance",
    staging: false,
    bindings: {},
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ CLOUDFLARE_BUILDS_READ_TOKEN: secret })
    )
  );

  return { seen, operation };
};

it.effect(
  "sends the user token only to the account's trigger-list GET for each incumbent script tag",
  () =>
    Effect.gen(function* () {
      const { seen, operation } = inspect("fixture-builds");
      const edge = yield* operation;
      expect(seen.toSorted()).toEqual(triggers.toSorted());
      expect(edge.builds.map((item) => item.triggerCount)).toEqual([0, 0, 0]);
    })
);

it.effect("refuses empty Builds credentials before making a trigger request", () =>
  Effect.gen(function* () {
    const { seen, operation } = inspect("");
    expect(Result.isFailure(yield* Effect.result(operation))).toBe(true);
    expect(seen).toEqual([]);
  })
);

it.effect("refuses a trigger that can deploy trunk even with the dedicated read credential", () =>
  Effect.gen(function* () {
    const { operation } = inspect("fixture-builds", [
      { branch_includes: ["tr*"], branch_excludes: [] },
    ]);

    expect(yield* Effect.flip(operation)).toEqual(
      Error("A Worker Build may deploy trunk to fidy-web")
    );
  })
);

it.effect("refuses an extra Ingress domain before reconciling the closed version upload", () =>
  Effect.gen(function* () {
    const attachment = {
      hostname: "native-api.fidyapp.com",
      service: "fidy-native-storage-ingress",
      zone_id: zone.id,
      enabled: true,
      previews_enabled: false,
    };

    const approved = { ...attachment, hostname: nativeIngressHost };

    yield* Effect.forEach(
      [
        [approved],
        [approved, { ...attachment, hostname: "api.fidyapp.com" }],
        [{ ...approved, previews_enabled: true }],
      ],
      Effect.fnUntraced(function* (rows) {
        const accepted = yield* requireClosedIngressDomains((path) => {
          expect(path).toContain("service=fidy-native-storage-ingress");

          return Effect.succeed({ success: true, result: rows });
        }).pipe(Effect.result);

        expect(Result.isSuccess(accepted)).toBe(
          rows.length === 1 && rows[0]?.previews_enabled === false
        );
      }),
      { discard: true }
    );
  })
);

it.effect("admits only the closed acceptance and canonical hosts during staged transfer", () =>
  Effect.gen(function* () {
    const attachment = (hostname: string, service: string): DomainAttachment => ({
      hostname,
      service,
      zone_id: zone.id,
      enabled: true,
      previews_enabled: false,
    });

    const web = "fidy-native-web";
    const ingress = "fidy-native-storage-ingress";

    const inspectDomains = (
      webHosts: readonly unknown[],
      staging: boolean
    ): ReturnType<typeof requireStagedHostDomains> =>
      requireStagedHostDomains(
        (path) =>
          Effect.succeed({
            success: true,
            result:
              new URL(path, "https://example.invalid").searchParams.get("service") === ingress
                ? [attachment(nativeIngressHost, ingress), attachment("api.fidyapp.com", ingress)]
                : webHosts,
          }),
        zone.id,
        staging
      );

    const acceptance = attachment(nativeWebHost, web);
    const canonical = attachment("app.fidyapp.com", web);
    yield* inspectDomains([acceptance], true);
    yield* inspectDomains([acceptance, canonical], false);

    yield* Effect.forEach(
      [
        [canonical],
        [acceptance],
        [acceptance, { ...canonical, zone_id: "foreign" }],
        [acceptance, canonical, attachment("other.fidyapp.com", web)],
      ],
      Effect.fnUntraced(function* (hosts) {
        expect(Result.isFailure(yield* Effect.result(inspectDomains(hosts, false)))).toBe(true);
      }),
      { discard: true }
    );
  })
);
