import { inspectNativeAccess } from "./native-deployed-access";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { type ProductionReleaseConfig, releaseEvidence } from "./production-release";
import { installationNames, nativeIngressHost, nativeWebHost } from "./storage-installation";

import { type ProviderRead as Read, readProviderList as readList } from "./native-provider-list";

const api = "https://api.cloudflare.com/client/v4/";
const worker = Schema.Struct({ id: Schema.NonEmptyString, tag: Schema.optional(Schema.String) });
const inspectBuilds = Effect.fn(function* (read: Read, account: string, installed: boolean) {
  const body = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ success: Schema.Literal(true), result: Schema.Array(worker) })
  )(yield* read(account + "workers/scripts"));
  const scripts = body.result.filter(
    (item) =>
      item.id.startsWith("fidycloudflare-") ||
      item.id.startsWith("fidy-native-") ||
      item.id === "fidy-web"
  );
  if (
    !scripts.some((item) => item.id === "fidy-web") ||
    !scripts.some((item) => item.id.startsWith("fidycloudflare-core-")) ||
    !scripts.some((item) => item.id.startsWith("fidycloudflare-ingress-")) ||
    (installed && !scripts.some((item) => item.id === installationNames.Core))
  ) {
    return yield* Effect.fail(Error("Incumbent or installed build identity unavailable"));
  }
  return yield* Effect.forEach(
    scripts,
    Effect.fn(function* (item) {
      if (
        item.tag === undefined ||
        !/^([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu.test(item.tag)
      ) {
        return yield* Effect.fail(Error("Missing Worker script tag for " + item.id));
      }
      const triggers = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          success: Schema.Literal(true),
          result: Schema.Array(
            Schema.Struct({
              branch_includes: Schema.Array(Schema.String),
              branch_excludes: Schema.Array(Schema.String),
            })
          ),
        })
      )(yield* read(account + "builds/workers/" + item.tag + "/triggers"));
      for (const trigger of triggers.result) {
        const matches = (pattern: string): boolean => new Bun.Glob(pattern).match("trunk");
        if (
          (trigger.branch_includes.length === 0 || trigger.branch_includes.some(matches)) &&
          !trigger.branch_excludes.some(matches)
        ) {
          return yield* Effect.fail(Error("A Worker Build may deploy trunk to " + item.id));
        }
      }
      return { script: item.id, tag: item.tag, triggerCount: triggers.result.length };
    }),
    { concurrency: 3 }
  );
});
const domain = Schema.Struct({
  hostname: Schema.NonEmptyString,
  service: Schema.NonEmptyString,
  zone_id: Schema.NonEmptyString,
});
const record = Schema.Struct({
  name: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  proxied: Schema.optional(Schema.Boolean),
});
const hosts = [
  [nativeIngressHost, installationNames.Ingress],
  [nativeWebHost, installationNames.Web],
] as const;
const dnsConfirmed = (rows: ReadonlyArray<typeof record.Type>, host: string): boolean =>
  rows.length > 0 &&
  rows.every(
    (item) =>
      item.name === host && item.proxied === true && ["A", "AAAA", "CNAME"].includes(item.type)
  );
const attachedTo = (
  rows: ReadonlyArray<typeof domain.Type>,
  host: string,
  target: { worker: string; zone: string }
): boolean =>
  rows.length === 1 &&
  rows[0]?.hostname === host &&
  rows[0].service === target.worker &&
  rows[0].zone_id === target.zone;
const inspectHosts = Effect.fn(function* (input: {
  read: Read;
  account: string;
  zone: string;
  zoneId: string;
  installed: boolean;
}) {
  const { read, account, zone, zoneId, installed } = input;
  const routes = yield* readList(
    read,
    zone + "workers/routes",
    Schema.Struct({ pattern: Schema.NonEmptyString })
  );
  for (const { pattern } of routes) {
    const hostname = pattern.replace(/^https?:\/\//u, "").split("/")[0];
    if (hostname === undefined || hosts.some(([host]) => new Bun.Glob(hostname).match(host))) {
      return yield* Effect.fail(Error("A zone Worker route overlaps the acceptance hostname"));
    }
  }
  return yield* Effect.forEach(
    hosts,
    Effect.fn(function* ([host, target]) {
      const attachments = yield* readList(
        read,
        account + "workers/domains?" + new URLSearchParams({ hostname: host, zone_id: zoneId }),
        domain
      );
      const dns = yield* readList(
        read,
        zone + "dns_records?" + new URLSearchParams({ "name.exact": host }),
        record
      );
      if (installed) {
        if (
          !attachedTo(attachments, host, { worker: target, zone: zoneId }) ||
          !dnsConfirmed(dns, host)
        ) {
          return yield* Effect.fail(
            Error("Installed DNS or Worker attachment differs for " + host)
          );
        }
      } else if (dns.length !== 0 || attachments.length !== 0) {
        return yield* Effect.fail(Error("Acceptance hostname already claimed: " + host));
      }
      return { host, target, dns: dns.map((item) => item.type) };
    })
  );
});
/** Verify live account and zone authority using the protected release credential. An unavailable read fails the operation. */
export const inspectDeployedEdge = Effect.fn(function* (
  env: ProductionReleaseConfig,
  client: HttpClient.HttpClient,
  stage: { installed: boolean; bindings: Readonly<Record<string, unknown>> }
) {
  const { installed } = stage;
  const read: Read = (path) =>
    releaseEvidence
      .providerJson(
        HttpClientRequest.get(api + path, { headers: { authorization: "Bearer " + env.token } })
      )
      .pipe(Effect.provideService(HttpClient.HttpClient, client));
  const account = "accounts/" + env.account + "/";
  const {
    result: [zone],
  } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      success: Schema.Literal(true),
      result: Schema.Tuple([
        Schema.Struct({
          id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
          name: Schema.Literal("fidyapp.com"),
          status: Schema.Literal("active"),
          account: Schema.Struct({ id: Schema.Literal(env.account) }),
        }),
      ]),
    })
  )(yield* read("zones?name=fidyapp.com&account.id=" + env.account));
  const attached = yield* inspectHosts({
    read,
    account,
    zone: "zones/" + zone.id + "/",
    zoneId: zone.id,
    installed,
  });
  const builds = yield* inspectBuilds(read, account, installed);
  const access = yield* inspectNativeAccess({
    read,
    account,
    zone: "zones/" + zone.id + "/",
    installed,
    hosts: hosts.map(([host]) => host),
    bindings: stage.bindings,
    workers: [
      ...Object.values(installationNames),
      ...builds
        .filter((item) => item.script.startsWith("fidy-native-"))
        .flatMap((item) => [item.tag, item.script]),
    ],
  });
  return { zoneId: zone.id, hosts: attached, builds, access };
});
