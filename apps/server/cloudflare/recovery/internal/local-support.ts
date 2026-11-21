import {
  DirectoryWriteUnavailable,
  FrozenRecovery,
  RecoveryCandidate,
  localRecoveryCheckUrl,
} from "../../directory/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";

import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";

const maximumWrongProofs = 5;

const refused = (): Response =>
  Response.json(
    { status: "not_approved" },
    { status: 400, headers: { "cache-control": "no-store" } }
  );

const stale = (handoff: typeof FrozenRecovery.Type, now: number): boolean =>
  handoff.expires_at_ms <= now ||
  handoff.operator_expires_ms <= now ||
  handoff.operator_issued_ms > now ||
  handoff.wrong_attempts >= maximumWrongProofs;

const checkCandidate = Effect.fn(function* (request: Request, owns: (id: string) => boolean) {
  const input = yield* Schema.decodeUnknownEffect(RecoveryCandidate)(
    yield* Effect.tryPromise(() => request.json())
  );

  if (!owns(input.user_id)) return refused();
  const sql = yield* SqliteClient;

  const found =
    yield* sql`SELECT 1 FROM backup_recovery_credentials WHERE user_id=${input.user_id} AND code_digest=unhex(${input.digest}) AND consumed_at_ms IS NULL AND revision=${input.revision} AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

  return found.length === 1 ? new Response(null, { status: 204 }) : refused();
});

export const localSupportApproval = Effect.fn(function* (
  request: Request,
  owns: (user: string) => boolean,
  storage: DurableObjectStorage
) {
  if (request.url === localRecoveryCheckUrl) return yield* checkCandidate(request, owns);

  const handoff = yield* Schema.decodeUnknownEffect(FrozenRecovery)(
    yield* Effect.tryPromise(() => request.json())
  );

  if (!owns(handoff.user_id)) return refused();
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    if (stale(handoff, now)) return refused();

    const [later] =
      yield* sql`SELECT 1 FROM browser_handoffs WHERE state='ready' AND ordinal>${handoff.ordinal} AND wrong_attempts<5 AND expires_at_ms>${now}`;

    if (later !== undefined) return refused();

    const used =
      yield* sql`UPDATE backup_recovery_credentials SET consumed_at_ms=${now} WHERE user_id=${handoff.user_id} AND code_digest=unhex(${handoff.credential_digest}) AND revision=${handoff.revision} AND consumed_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_requests) AND NOT EXISTS(SELECT 1 FROM browser_handoffs WHERE pairing_id=${handoff.pairing_id}) RETURNING 1`;

    if (used.length !== 1) return refused();
    yield* sql`UPDATE browser_handoffs SET state='invalidated' WHERE state='ready' AND ordinal<${handoff.ordinal}`;

    const ready =
      yield* sql`INSERT INTO browser_handoffs(id,pairing_id,user_id,ordinal,verifier_digest,expires_at_ms,wrong_attempts,last_poll_ms,minimum_poll_seconds,outcome,state) VALUES(${handoff.id},${handoff.pairing_id},${handoff.user_id},${handoff.ordinal},${handoff.verifier_digest},${handoff.expires_at_ms},${handoff.wrong_attempts},${handoff.last_poll_ms},${handoff.minimum_poll_seconds},'committed','ready') RETURNING 1`;

    const evidence =
      yield* sql`INSERT INTO support_recovery_cases VALUES(${handoff.id},${handoff.user_id},${handoff.pairing_id},${handoff.operator_issuer},${handoff.operator_subject},${handoff.revision},${now},${handoff.expires_at_ms},'approved',${now}) RETURNING 1`;

    if (ready.length !== 1 || evidence.length !== 1) return yield* new DirectoryWriteUnavailable();

    return Response.json({ status: "approved" }, { headers: { "cache-control": "no-store" } });
  }).pipe(
    withStoreCapacity("growth"),
    Effect.tap((response) => (response.ok ? repairSupportRetention(storage) : Effect.void))
  );
});

const supportPageSize = 32;

const pendingCase = Effect.gen(function* () {
  const sql = yield* SqliteClient;

  const [first] =
    yield* sql`SELECT user_id,retained_until_ms FROM support_recovery_cases WHERE NOT EXISTS(SELECT 1 FROM erasure_requests) ORDER BY retained_until_ms,id LIMIT 1`;

  return yield* Schema.decodeUnknownEffect(
    Schema.OptionFromUndefinedOr(
      Schema.Struct({ user_id: Schema.String, retained_until_ms: Schema.Int })
    )
  )(first);
});

export const repairSupportRetention = Effect.fn(function* (storage: DurableObjectStorage) {
  const pending = yield* pendingCase;

  return Option.isNone(pending)
    ? false
    : yield* preserveStoreAlarm(storage, pending.value.retained_until_ms);
});

export const expireSupportCases = Effect.fn(function* (
  current: number,
  storage: DurableObjectStorage,
  owns: (id: string) => boolean
) {
  const earliest = yield* pendingCase;

  if (Option.isNone(earliest)) return { attempted: 0, failed: 0 };
  const { user_id: user, retained_until_ms: due } = earliest.value;

  if (!owns(user)) return yield* new DirectoryWriteUnavailable();

  if (due > current) {
    yield* preserveStoreAlarm(storage, due);

    return { attempted: 0, failed: 0 };
  }

  const sql = yield* SqliteClient;

  const removed = yield* withStoreCapacity("required")(
    sql`DELETE FROM support_recovery_cases WHERE id IN (SELECT id FROM support_recovery_cases WHERE user_id=${user} AND retained_until_ms<=${current} AND NOT EXISTS(SELECT 1 FROM erasure_requests) ORDER BY retained_until_ms,id LIMIT ${supportPageSize}) RETURNING id`
  );

  yield* repairSupportRetention(storage);

  return { attempted: removed.length, failed: 0 };
});
