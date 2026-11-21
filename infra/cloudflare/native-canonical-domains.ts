import { Effect, Schedule, Schema } from "effect";
import { installedOrigins } from "@fidy/server/browser-transport";
import { installationNames } from "./storage-installation";

export const canonicalDomains = [
  {
    host: new URL(installedOrigins.production.api).hostname,
    incumbentId: "133265e618b99c89427c1c04e274028e8caf50ba",
    incumbent: "fidycloudflare-ingress-production-hf6ajjsszff23h5z",
    native: installationNames.Ingress,
  },
  {
    host: new URL(installedOrigins.production.browser).hostname,
    incumbentId: "6d1dc510634cbcd8a6dcc1708f6b3d90df0f9ef4",
    incumbent: "fidy-web",
    native: installationNames.Web,
  },
] as const;
export type CanonicalDomain = (typeof canonicalDomains)[number];
type DomainState =
  | Readonly<{ vacant: true }>
  | Readonly<{ vacant: false; id: string; service: string }>;

export type CanonicalDomainPort = Readonly<{
  read: (domain: CanonicalDomain) => Effect.Effect<DomainState, Error>;
  move: (
    domain: CanonicalDomain,
    service: string
  ) => Effect.Effect<void, Error | Schema.SchemaError>;
}>;

const domainChangeset = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    added: Schema.Tuple([]),
    conflicting: Schema.Tuple([]),
    removed: Schema.Tuple([]),
    updated: Schema.Tuple([
      Schema.Struct({
        id: Schema.NonEmptyString,
        hostname: Schema.NonEmptyString,
        zone_id: Schema.NonEmptyString,
        service: Schema.NonEmptyString,
        enabled: Schema.Literal(true),
        previews_enabled: Schema.Literal(false),
        modified: Schema.Literal(true),
      }),
    ]),
  }),
});

export const confirmCanonicalDomainMove = Effect.fn(function* (
  raw: unknown,
  domain: CanonicalDomain,
  target: { service: string; zoneId: string }
) {
  const { result } = yield* Schema.decodeUnknownEffect(domainChangeset)(raw);
  const [change] = result.updated;
  if (
    change.id !== domain.incumbentId ||
    change.hostname !== domain.host ||
    change.zone_id !== target.zoneId ||
    change.service !== target.service
  ) {
    return yield* Effect.fail(Error("Cloudflare preview differs for " + domain.host));
  }
});

const requireIncumbent = Effect.fn(function* (
  port: Pick<CanonicalDomainPort, "read">,
  domain: CanonicalDomain
) {
  const current = yield* port.read(domain);
  if (current.vacant || current.id !== domain.incumbentId || current.service !== domain.incumbent) {
    return yield* Effect.fail(Error("Canonical incumbent identity changed for " + domain.host));
  }
});
export const checkCanonicalIncumbents = (
  read: CanonicalDomainPort["read"]
): Effect.Effect<void, Error> =>
  Effect.forEach(canonicalDomains, (domain) => requireIncumbent({ read }, domain), {
    discard: true,
  });

const providerPropagation = { times: 6, schedule: Schedule.spaced("1 second") };
const requireAttachment = Effect.fn(function* (
  port: CanonicalDomainPort,
  domain: CanonicalDomain,
  service: string
) {
  const current = yield* port.read(domain);
  if (current.vacant || current.id !== domain.incumbentId || current.service !== service) {
    return yield* Effect.fail(
      Error("Canonical attachment could not be verified for " + domain.host)
    );
  }
});

const restore = Effect.fn(function* (port: CanonicalDomainPort, domain: CanonicalDomain) {
  const current = yield* port.read(domain).pipe(Effect.retry(providerPropagation));
  if (current.vacant || current.id !== domain.incumbentId) {
    return yield* Effect.fail(
      Error("Unexpected canonical domain during recovery for " + domain.host)
    );
  }
  if (current.service === domain.incumbent) return;
  if (current.service !== domain.native) {
    return yield* Effect.fail(
      Error("Unexpected canonical owner during recovery for " + domain.host)
    );
  }
  yield* port.move(domain, domain.incumbent);
  yield* requireAttachment(port, domain, domain.incumbent).pipe(Effect.retry(providerPropagation));
});
export const transferCanonicalDomains = Effect.fn(function* <A, E, R>(
  port: CanonicalDomainPort,
  verify: Effect.Effect<A, E, R>
) {
  yield* checkCanonicalIncumbents(port.read);
  const attempted: CanonicalDomain[] = [];
  const compensate = Effect.forEach(
    attempted,
    (domain) =>
      restore(port, domain).pipe(
        Effect.tapError(() =>
          Effect.logError("Canonical recovery needs inspection for " + domain.host)
        ),
        Effect.ignore
      ),
    { discard: true }
  );
  return yield* Effect.gen(function* () {
    for (const domain of canonicalDomains) {
      yield* requireIncumbent(port, domain);
      attempted.unshift(domain);
      yield* port.move(domain, domain.native);
      yield* requireAttachment(port, domain, domain.native).pipe(Effect.retry(providerPropagation));
      yield* Effect.logInfo("Verified canonical domain transfer for " + domain.host);
    }
    return yield* verify;
  }).pipe(
    Effect.onError(() => compensate),
    Effect.uninterruptible
  );
});
