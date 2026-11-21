import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { expect } from "vitest";
import {
  type CanonicalDomainPort,
  canonicalDomains,
  confirmCanonicalDomainMove,
  transferCanonicalDomains,
} from "./native-canonical-domains";

const testPort = (
  interfere: "none" | "second-attachment" | "foreign-before" = "none"
): {
  port: CanonicalDomainPort;
  rows: Map<string, { id: string; service: string }>;
  writes: string[];
} => {
  const writes: string[] = [];
  const rows = new Map<string, { id: string; service: string }>(
    canonicalDomains.map((domain) => [
      domain.host,
      {
        id: domain.incumbentId,
        service: domain.incumbent,
      },
    ])
  );
  const port: CanonicalDomainPort = {
    read: (domain) =>
      Effect.sync(() => {
        const attachment = rows.get(domain.host);
        return attachment !== undefined ? { ...attachment, vacant: false } : { vacant: true };
      }),
    move: (domain, service) =>
      Effect.gen(function* () {
        writes.push("move " + domain.host + " " + service);
        rows.set(domain.host, { id: domain.incumbentId, service });
        if (
          interfere === "second-attachment" &&
          domain.host === "app.fidyapp.com" &&
          service === domain.native
        ) {
          return yield* Effect.fail(Error("lost attachment response"));
        }
      }),
  };
  if (interfere === "foreign-before") {
    rows.set("app.fidyapp.com", { id: "foreign", service: "foreign-worker" });
  }
  return { port, rows, writes };
};

it.effect("moves both exact incumbent domains and retains their verified Native ownership", () =>
  Effect.gen(function* () {
    const { port, rows, writes } = testPort();
    yield* transferCanonicalDomains(port, Effect.void);
    expect(canonicalDomains.map(({ host }) => rows.get(host)?.service)).toEqual([
      "fidy-native-storage-ingress",
      "fidy-native-web",
    ]);
    expect(writes).toHaveLength(2);
  })
);

it.effect("restores both incumbents after a lost successful attachment response", () =>
  Effect.gen(function* () {
    const { port, rows, writes } = testPort("second-attachment");
    const result = yield* Effect.result(transferCanonicalDomains(port, Effect.void));
    expect(Result.isFailure(result)).toBe(true);
    expect(canonicalDomains.map(({ host }) => rows.get(host)?.service)).toEqual([
      "fidycloudflare-ingress-production-hf6ajjsszff23h5z",
      "fidy-web",
    ]);
    expect(writes).toHaveLength(4);
  })
);

it.effect("refuses foreign incumbent identity before moving either host", () =>
  Effect.gen(function* () {
    const { port, writes } = testPort("foreign-before");
    expect(
      Result.isFailure(yield* Effect.result(transferCanonicalDomains(port, Effect.void)))
    ).toBe(true);
    expect(writes).toEqual([]);
  })
);

it.effect("allows only an in-place change to the pinned canonical domain", () =>
  Effect.gen(function* () {
    const [domain] = canonicalDomains;
    const zoneId = "fidy-zone";
    const result = {
      added: [],
      conflicting: [],
      removed: [],
      updated: [
        {
          id: domain.incumbentId,
          hostname: domain.host,
          zone_id: zoneId,
          service: domain.native,
          enabled: true,
          previews_enabled: false,
          modified: true,
        },
      ],
    };
    const target = { service: domain.native, zoneId };
    yield* confirmCanonicalDomainMove({ success: true, result }, domain, target);
    const removesAcceptanceHost = {
      ...result,
      removed: [{ hostname: "storage-acceptance.fidyapp.com" }],
    };
    const rejected = yield* Effect.result(
      confirmCanonicalDomainMove({ success: true, result: removesAcceptanceHost }, domain, target)
    );
    expect(Result.isFailure(rejected)).toBe(true);
  })
);
