import type { WorkerBindings } from "./rollback-compatibility";
import type { ReadCanonicalDomain } from "./native-canonical-domains";
import { installedOrigins } from "@fidy/server/browser-transport";
import { inspectNativeAccess } from "./native-deployed-access";
import { Config, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { type ProductionReleaseConfig, releaseEvidence } from "./production-release";
import {
  type NativeHostMode,
  installationNames,
  nativeHostPairs,
  nativeIngressHost,
  nativeWebHost,
} from "./storage-installation";

import { type ProviderRead as Read, readProviderList as readList } from "./native-provider-list";

const api = "https://api.cloudflare.com/client/v4/";

const worker = Schema.Struct({ id: Schema.NonEmptyString, tag: Schema.optional(Schema.String) });

const readBuildTriggers = Effect.fn(function* (
  client: HttpClient.HttpClient,
  account: string,
  tag: string
) {
  const token = yield* Config.schema(
    Schema.Redacted(Schema.NonEmptyString.check(Schema.isTrimmed())),
    "CLOUDFLARE_BUILDS_READ_TOKEN"
  );

  const request = HttpClientRequest.get(api + account + "builds/workers/" + tag + "/triggers").pipe(
    HttpClientRequest.bearerToken(token)
  );

  return yield* releaseEvidence.providerJson(request).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          success: Schema.Literal(true),
          result: Schema.Array(
            Schema.Struct({
              branch_includes: Schema.Array(Schema.String),
              branch_excludes: Schema.Array(Schema.String),
            })
          ),
        })
      )
    )
  );
});

const inspectBuilds = Effect.fn(function* ({
  read,
  account,
  installed,
  client,
}: {
  read: Read;
  account: string;
  installed: boolean;
  client: HttpClient.HttpClient;
}) {
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

      const triggers = yield* readBuildTriggers(client, account, item.tag);

      yield* Effect.forEach(
        triggers.result,
        Effect.fnUntraced(function* (trigger) {
          const matches = (pattern: string): boolean => new Bun.Glob(pattern).match("trunk");

          if (
            (trigger.branch_includes.length === 0 || trigger.branch_includes.some(matches)) &&
            !trigger.branch_excludes.some(matches)
          ) {
            return yield* Effect.fail(Error("A Worker Build may deploy trunk to " + item.id));
          }
        }),
        { discard: true }
      );

      return { script: item.id, tag: item.tag, triggerCount: triggers.result.length };
    }),
    { concurrency: 3 }
  );
});

const domain = Schema.Struct({
  id: Schema.optional(Schema.NonEmptyString),
  hostname: Schema.NonEmptyString,
  service: Schema.NonEmptyString,
  zone_id: Schema.NonEmptyString,
  enabled: Schema.Boolean,
  previews_enabled: Schema.Boolean,
});

export const requireClosedIngressDomains = Effect.fn(function* (read: Read) {
  const rows = yield* readList(
    read,
    "workers/domains?service=" + installationNames.Ingress,
    domain
  );

  const [only] = rows;

  if (
    rows.length !== 1 ||
    only?.service !== installationNames.Ingress ||
    only.hostname !== nativeIngressHost ||
    !only.enabled ||
    only.previews_enabled
  ) {
    return yield* Effect.fail(
      Error("Native Ingress domain inventory differs from closed acceptance")
    );
  }
});

export const requireStagedHostDomains = Effect.fn(function* (
  read: Read,
  zoneId: string,
  staging: boolean
) {
  const hosts = [
    [
      installationNames.Ingress,
      nativeIngressHost,
      new URL(installedOrigins.production.api).hostname,
    ],
    [installationNames.Web, nativeWebHost, new URL(installedOrigins.production.browser).hostname],
  ] as const;

  yield* Effect.forEach(
    hosts,
    Effect.fn(function* ([service, acceptance, canonical]) {
      const rows = yield* readList(read, "workers/domains?service=" + service, domain);
      const names = new Set(rows.map((row) => row.hostname));

      if (
        rows.some(
          (row) =>
            row.service !== service ||
            row.zone_id !== zoneId ||
            !row.enabled ||
            row.previews_enabled
        ) ||
        names.size !== rows.length ||
        !names.has(acceptance) ||
        (names.size === 1 ? !staging : names.size !== 2 || !names.has(canonical))
      ) {
        return yield* Effect.fail(Error("Unexpected installed domain inventory for " + service));
      }
    }),
    { discard: true }
  );
});

const record = Schema.Struct({
  name: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  proxied: Schema.optional(Schema.Boolean),
});

const hostWorkers = (mode: NativeHostMode): ReadonlyArray<readonly [string, string]> =>
  nativeHostPairs(mode).flatMap((pair) => [
    [new URL(pair.api).hostname, installationNames.Ingress] as const,
    [new URL(pair.browser).hostname, installationNames.Web] as const,
  ]);

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
  rows[0].zone_id === target.zone &&
  rows[0].enabled &&
  !rows[0].previews_enabled;

export const canonicalDomainReader = ({
  readAccount,
  readZone,
  zoneId,
}: {
  readAccount: Read;
  readZone: Read;
  zoneId: string;
}): ReadCanonicalDomain =>
  Effect.fn(function* (route) {
    const hosts = yield* readList(
      readAccount,
      "workers/domains?" + new URLSearchParams({ hostname: route.host, zone_id: zoneId }),
      domain
    );

    const dns = yield* readList(
      readZone,
      "dns_records?" + new URLSearchParams({ "name.exact": route.host }),
      record
    );

    if (hosts.length === 0 && dns.length === 0) return { vacant: true } as const;
    const [current] = hosts;

    if (
      current?.id === undefined ||
      !attachedTo(hosts, route.host, { worker: current.service, zone: zoneId }) ||
      !dnsConfirmed(dns, route.host)
    ) {
      return yield* Effect.fail(Error("Unverified canonical attachment or DNS for " + route.host));
    }

    return { vacant: false, id: current.id, service: current.service } as const;
  });

const hostStateAllowed = (state: {
  expected: boolean;
  vacant: boolean;
  installed: boolean;
  stagingAlias: boolean;
}): boolean => state.expected || (state.vacant && (!state.installed || state.stagingAlias));

const inspectHosts = Effect.fn(function* (input: {
  read: Read;
  account: string;
  zone: string;
  zoneId: string;
  installed: boolean;
  hosts: ReturnType<typeof hostWorkers>;
  staging: boolean;
}) {
  const { read, account, zone, zoneId, installed, hosts } = input;

  const routes = yield* readList(
    read,
    zone + "workers/routes",
    Schema.Struct({ pattern: Schema.NonEmptyString })
  );

  yield* Effect.forEach(
    routes,
    Effect.fnUntraced(function* ({ pattern }) {
      const hostname = pattern.replace(/^https?:\/\//u, "").split("/")[0];

      if (hostname === undefined || hosts.some(([host]) => new Bun.Glob(hostname).match(host))) {
        return yield* Effect.fail(Error("A zone Worker route overlaps the acceptance hostname"));
      }
    }),
    { discard: true }
  );

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

      const vacant = attachments.length === 0 && dns.length === 0;

      const canonical = [installedOrigins.production.api, installedOrigins.production.browser].some(
        (origin) => new URL(origin).hostname === host
      );

      const expected =
        installed &&
        attachedTo(attachments, host, { worker: target, zone: zoneId }) &&
        dnsConfirmed(dns, host);

      if (
        !hostStateAllowed({ expected, vacant, installed, stagingAlias: input.staging && canonical })
      ) {
        return yield* Effect.fail(Error("Unexpected DNS or Worker attachment for " + host));
      }

      return { host, target, vacant, dns: dns.map((item) => item.type) };
    })
  );
});

const readZone = Effect.fn(function* (read: Read, accountId: string) {
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
          account: Schema.Struct({ id: Schema.Literal(accountId) }),
        }),
      ]),
    })
  )(yield* read("zones?name=fidyapp.com&account.id=" + accountId));

  return zone;
});

const checkCanonicalInventory =
  (mode: NativeHostMode, section: string) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    work.pipe(
      Effect.tapCause(() =>
        mode === "staged"
          ? Effect.logError("Canonical edge inventory failed at " + section)
          : Effect.void
      )
    );

export const inspectDeployedEdge = Effect.fn(function* (
  env: Pick<ProductionReleaseConfig, "account" | "token">,
  client: HttpClient.HttpClient,
  stage: {
    installed: boolean;
    bindings: WorkerBindings;
    hosts: NativeHostMode;
    staging: boolean;
  }
) {
  const { installed } = stage;

  const read: Read = (path) =>
    releaseEvidence
      .providerJson(
        HttpClientRequest.get(api + path, { headers: { authorization: "Bearer " + env.token } })
      )
      .pipe(Effect.provideService(HttpClient.HttpClient, client));

  const account = "accounts/" + env.account + "/";

  const zone = yield* readZone(read, env.account).pipe(
    checkCanonicalInventory(stage.hosts, "zone identity")
  );

  const hosts = hostWorkers(stage.hosts);

  const attached = yield* inspectHosts({
    read,
    account,
    zone: "zones/" + zone.id + "/",
    zoneId: zone.id,
    hosts,
    staging: stage.staging === true,
    installed,
  }).pipe(checkCanonicalInventory(stage.hosts, "DNS and Worker attachments"));

  const builds = yield* inspectBuilds({ read, account, installed, client }).pipe(
    checkCanonicalInventory(stage.hosts, "Workers Builds triggers")
  );

  const access = yield* inspectNativeAccess({
    read,
    account,
    zone: "zones/" + zone.id + "/",
    installed,
    staging: stage.staging === true,
    canonicalDiagnostics: stage.hosts === "staged",
    hosts: hosts.map(([host]) => host),
    apiHosts: hosts
      .filter(([, worker]) => worker === installationNames.Ingress)
      .map(([host]) => host),
    bindings: stage.bindings,
    workers: [
      ...Object.values(installationNames),
      ...builds
        .filter((item) => item.script.startsWith("fidy-native-"))
        .flatMap((item) => [item.tag, item.script]),
    ],
  }).pipe(
    checkCanonicalInventory(stage.hosts, "protected Access applications, policies and bindings")
  );

  return { zoneId: zone.id, hosts: attached, builds, access };
});
