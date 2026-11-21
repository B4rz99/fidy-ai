import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Predicate, Schema } from "effect";
import { ErasureCustodian } from "../../../src/core/erasure/contract";
import { directoryName } from "../../directory/contract";
import { pricingName } from "../../subscription/contract";
import { expireLifetimeUrl, maintenanceName, retireLifetimeUrl } from "../../maintenance/contract";
import {
  CleanupCommand,
  CleanupProgress,
  type ErasureHandoff,
  erasureRecoveryWindowMs,
  participantCleanupUrl,
} from "../contract";

const acknowledged = 204,
  okStatus = 200;

const quietCheckMs = 3_600_000;

const closed = "status IN('Verified','NotApplicable') AND event_id IS NOT NULL";

type Participants = Readonly<
  Record<"DIRECTORY" | "PRICING" | "MAINTENANCE", Pick<DurableObjectNamespace, "getByName">>
>;

type Scope = typeof ErasureHandoff.Type;

export const confirmCleanup = Effect.fn(function* (request: Request) {
  const scope = yield* Schema.decodeUnknownEffect(CleanupCommand, { onExcessProperty: "error" })(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const phase = {
    clean: sql`state='ExternalPending'`,
    release: sql`state='Complete'`,
    expire: sql`state='Complete' AND identity_released=1 AND lifetime_retired=1 AND protect_until_ms<=${now}`,
  }[scope.action];

  const granted =
    yield* sql`SELECT 1 FROM erasure_cases WHERE user_id=${scope.userId} AND reference=${scope.reference} AND requested_at_ms=${scope.requestedAtMs} AND ${phase}`;

  if (granted.length !== 1) return new Response(null, { status: 409 });

  const owners =
    yield* sql`SELECT custodian FROM erasure_case_custodians WHERE reference=${scope.reference} AND ${sql.unsafe(closed)}`;

  const covered = new Set(owners.map((row) => row.custodian));

  return Response.json({
    wompi: covered.has("Wompi"),
    whatsapp: covered.has("Kapso") && covered.has("Meta"),
  });
});

const cleanup = Effect.fn(function* (
  owner: Pick<Fetcher, "fetch">,
  record: Scope,
  action: typeof CleanupCommand.Type.action
) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(CleanupCommand))({
    ...record,
    action,
  });

  return yield* Effect.tryPromise((signal) =>
    owner.fetch(participantCleanupUrl, { method: "POST", body, signal })
  ).pipe(Effect.timeout("5 seconds"));
});

const lifetime = Effect.fn(function* (env: Participants, scope: Scope, url: string) {
  const response = yield* Effect.tryPromise((signal) =>
    env.MAINTENANCE.getByName(maintenanceName).fetch(url, {
      method: "POST",
      headers: { "fidy-user-id": scope.userId, "fidy-erasure-reference": scope.reference },
      signal,
    })
  ).pipe(Effect.timeout("5 seconds"));

  return response.status === acknowledged;
});

const settleParticipant = Effect.fn(function* (
  scope: Scope,
  owner: Pick<Fetcher, "fetch">,
  flag: "directory_clean" | "pricing_clean"
) {
  const sql = yield* SqliteClient;

  const pending =
    yield* sql`SELECT 1 FROM erasure_cases WHERE reference=${scope.reference} AND state='ExternalPending' AND ${sql(flag)}=0`;

  if (pending.length !== 1) return;
  const response = yield* cleanup(owner, scope, "clean");

  if (response.status !== okStatus) return;

  const progress = yield* Schema.decodeUnknownEffect(CleanupProgress)(
    yield* Effect.tryPromise(() => response.json())
  );

  yield* sql`UPDATE erasure_cases SET ${sql(flag)}=${Number(progress.done)},last_erased_at_ms=max(last_erased_at_ms,${progress.lastErasedAtMs}),protect_until_ms=max(protect_until_ms,${progress.protectUntilMs}) WHERE reference=${scope.reference} AND state='ExternalPending' AND ${sql(flag)}=0`;
});

const settleCustodians = Effect.fn(function* (scope: Scope, env: Participants) {
  const sql = yield* SqliteClient;

  const owners = [
    { owner: env.DIRECTORY.getByName(directoryName), flag: "directory_clean" },
    { owner: env.PRICING.getByName(pricingName), flag: "pricing_clean" },
  ] as const;

  yield* Effect.forEach(owners, ({ owner, flag }) => settleParticipant(scope, owner, flag), {
    discard: true,
  });

  const now = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE erasure_cases SET state='Complete' WHERE user_id=${scope.userId} AND reference=${scope.reference} AND state='ExternalPending' AND directory_fenced=1 AND pricing_fenced=1 AND maintenance_fenced=1 AND shared_drained=1 AND drained_at_ms IS NOT NULL AND directory_clean=1 AND pricing_clean=1 AND last_erased_at_ms+${erasureRecoveryWindowMs}<=${now}
    AND (SELECT count(*) FROM erasure_case_custodians c JOIN erasure_case_evidence e ON c.event_id=e.id AND e.reference=c.reference AND e.custodian=c.custodian AND e.status=c.status WHERE c.reference=${scope.reference} AND c.status IN('Verified','NotApplicable') AND (c.custodian<>'Cloudflare' OR (e.status='Verified' AND e.recorded_at_ms>=erasure_cases.last_erased_at_ms+${erasureRecoveryWindowMs})))=${ErasureCustodian.literals.length}`;
  yield* sql`UPDATE erasure_cases SET next_check_ms=${now + quietCheckMs} WHERE reference=${scope.reference} AND state='ExternalPending' AND directory_clean=1 AND pricing_clean=1 AND next_check_ms>${now}`;
});

export const finishErasure = Effect.fn(function* (
  scope: Scope & { state: string },
  env: Participants
) {
  if (scope.state === "ExternalPending") return yield* settleCustodians(scope, env);
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT identity_released,lifetime_retired,protect_until_ms,directory_expired,pricing_expired,maintenance_expired FROM erasure_cases WHERE reference=${scope.reference} AND user_id=${scope.userId} AND state='Complete'`;

  if (row === undefined) return;

  if (row.identity_released !== 1) {
    if (
      (yield* cleanup(env.DIRECTORY.getByName(directoryName), scope, "release")).status ===
      acknowledged
    ) {
      yield* sql`UPDATE erasure_cases SET identity_released=1 WHERE reference=${scope.reference}`;
    }

    return;
  }

  if (row.lifetime_retired !== 1) {
    if (yield* lifetime(env, scope, retireLifetimeUrl)) {
      yield* sql`UPDATE erasure_cases SET lifetime_retired=1 WHERE reference=${scope.reference}`;
    }

    return;
  }

  yield* expireCase(scope, env, row);
});

const ExpiringCase = Schema.Struct({
  protect_until_ms: Schema.Unknown,
  directory_expired: Schema.Unknown,
  pricing_expired: Schema.Unknown,
  maintenance_expired: Schema.Unknown,
});

const expireParticipant = Effect.fn(function* (
  scope: Scope,
  owner: Pick<Fetcher, "fetch">,
  flag: "directory_expired" | "pricing_expired"
) {
  const sql = yield* SqliteClient;

  if ((yield* cleanup(owner, scope, "expire")).status === acknowledged) {
    yield* sql`UPDATE erasure_cases SET ${sql(flag)}=1 WHERE reference=${scope.reference}`;
  }
});

const expireCase = Effect.fn(function* (scope: Scope, env: Participants, raw: unknown) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  const row = yield* Schema.decodeUnknownEffect(ExpiringCase)(raw);

  if (!Predicate.isNumber(row.protect_until_ms)) return;

  if (row.protect_until_ms > now) {
    yield* sql`UPDATE erasure_cases SET next_check_ms=protect_until_ms WHERE reference=${scope.reference} AND next_check_ms>${now}`;

    return;
  }

  const owners = [
    { owner: env.DIRECTORY.getByName(directoryName), flag: "directory_expired" },
    { owner: env.PRICING.getByName(pricingName), flag: "pricing_expired" },
  ] as const;

  const unexpired = owners.filter(({ flag }) => row[flag] !== 1);

  yield* Effect.forEach(unexpired, ({ owner, flag }) => expireParticipant(scope, owner, flag), {
    discard: true,
  });

  if (row.maintenance_expired !== 1 && (yield* lifetime(env, scope, expireLifetimeUrl))) {
    yield* sql`UPDATE erasure_cases SET maintenance_expired=1 WHERE reference=${scope.reference}`;
  }

  yield* sql`DELETE FROM erasure_cases WHERE reference=${scope.reference} AND user_id=${scope.userId} AND identity_released=1 AND lifetime_retired=1 AND directory_expired=1 AND pricing_expired=1 AND maintenance_expired=1 AND protect_until_ms<=${now}`;
});
