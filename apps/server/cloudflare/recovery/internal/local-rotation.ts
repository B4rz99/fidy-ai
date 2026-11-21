import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { UserId } from "../../../src/core/identity/contract";
import { readBoundWebSessionProof } from "../../web-session/operations";
import { RecoveryRotation, directoryName, rotateRecoveryRouteUrl } from "../../directory/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { canonicalAdmissionUnavailable, noAuthority } from "../../canonical-admission/operations";
import { newId } from "../../secret-material/operations";
import { recoveryCodeDigest, sampleRecoveryCode } from "./material";

type Rotation = typeof RecoveryRotation.Type;

type Directory = Pick<DurableObjectNamespace, "getByName">;

type Decision = "reserve" | "committed" | "cancelled";

class RecoveryWriteUnavailable extends Data.TaggedError("RecoveryWriteUnavailable") {}

const freshRequired = (): Response =>
  Response.json(
    {
      error: {
        code: "user_action_required",
        message: "Sign in again before rotating your recovery code.",
      },
      next: [],
    },
    { status: 403, headers: { "cache-control": "no-store" } }
  );

const readProof = Effect.fn(function* (
  proof: { digest: Uint8Array; binding: string },
  owns: (id: string) => boolean
) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const [raw] =
    yield* sql`SELECT user_id,fresh_until_ms FROM web_sessions WHERE id=${proof.binding} AND token_digest=${proof.digest} AND revoked_at_ms IS NULL AND idle_expires_at_ms>${now} AND hard_expires_at_ms>${now} AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

  if (raw === undefined) return noAuthority();

  const session = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ user_id: UserId, fresh_until_ms: Schema.Int })
  )(raw);

  if (!owns(session.user_id)) return noAuthority();

  return session.fresh_until_ms > now ? session : freshRequired();
});

const publish = Effect.fn(function* (directory: Directory, record: Rotation, decision: Decision) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    ...record,
    decision,
  });

  return yield* Effect.tryPromise((signal) =>
    directory.getByName(directoryName).fetch(rotateRecoveryRouteUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    })
  );
});

const settle = Effect.fn(function* (
  directory: Directory,
  record: Rotation,
  state: "committed" | "cancelled"
) {
  const response = yield* publish(directory, record, state);

  if (!response.ok) return yield* new RecoveryWriteUnavailable();
  const sql = yield* SqliteClient;
  yield* sql`DELETE FROM recovery_rotations WHERE id=${record.id} AND user_id=${record.user_id} AND state=${state}`;
});

const prepare = Effect.fn(function* ({
  proof,
  owns,
  next,
  storage,
}: Readonly<{
  proof: { digest: Uint8Array; binding: string };
  owns: (id: string) => boolean;
  next: string;
  storage: DurableObjectStorage;
}>) {
  const sql = yield* SqliteClient;
  const session = yield* readProof(proof, owns);

  if (isResponse(session)) return session;

  const [raw] =
    yield* sql`SELECT lower(hex(code_digest)) AS prior_digest,revision FROM backup_recovery_credentials WHERE user_id=${session.user_id}`;

  if (raw === undefined) return noAuthority();

  const record = yield* Schema.decodeUnknownEffect(RecoveryRotation)({
    ...raw,
    id: newId(),
    user_id: session.user_id,
    next_digest: next,
    expires_at_ms: session.fresh_until_ms,
  });

  yield* sql`INSERT INTO recovery_rotations VALUES(${record.id},${record.user_id},${record.prior_digest},${next},${record.revision},${record.expires_at_ms},'pending')`;
  yield* preserveStoreAlarm(storage, record.expires_at_ms);

  return record;
});

const activate = Effect.fn(function* ({
  proof,
  owns,
  record,
  next,
}: Readonly<{
  proof: { digest: Uint8Array; binding: string };
  owns: (id: string) => boolean;
  record: Rotation;
  next: Uint8Array;
}>) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  const session = yield* readProof(proof, owns);

  if (isResponse(session) || session.user_id !== record.user_id) {
    yield* sql`UPDATE recovery_rotations SET state='cancelled' WHERE id=${record.id} AND state='pending'`;

    return isResponse(session) ? session : noAuthority();
  }

  const changed =
    yield* sql`UPDATE backup_recovery_credentials SET code_digest=${next},revision=revision+1,created_at_ms=${now},consumed_at_ms=NULL WHERE user_id=${record.user_id} AND revision=${record.revision} AND lower(hex(code_digest))=${record.prior_digest} AND EXISTS(SELECT 1 FROM recovery_rotations WHERE id=${record.id} AND state='pending' AND expires_at_ms>${now}) RETURNING 1`;

  if (changed.length === 0) {
    yield* sql`UPDATE recovery_rotations SET state='cancelled' WHERE id=${record.id} AND state='pending'`;

    return noAuthority();
  }

  const audit =
    yield* sql`INSERT INTO audit_entries(id,user_id,session_id,record_type,operation,occurred_at_ms) VALUES(${record.id},${record.user_id},${proof.binding},'security_mutation','recovery.rotateBackupRecoveryCode',${now}) RETURNING 1`;

  const marked =
    yield* sql`UPDATE recovery_rotations SET state='committed' WHERE id=${record.id} AND state='pending' RETURNING 1`;

  if (audit.length !== 1 || marked.length !== 1) return yield* new RecoveryWriteUnavailable();

  return now;
});

const isResponse = Schema.is(Schema.instanceOf(Response));

export const rotateLocalRecovery = Effect.fn(
  function* ({
    request,
    directory,
    owns,
    storage,
  }: Readonly<{
    request: Request;
    directory: Directory;
    owns: (id: string) => boolean;
    storage: DurableObjectStorage;
  }>) {
    const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));

    if (Option.isNone(proof)) return noAuthority();
    const code = sampleRecoveryCode();
    const digest = yield* Effect.tryPromise(() => recoveryCodeDigest(code));

    const record = yield* prepare({
      proof: proof.value,
      owns,
      next: Hex.encode(digest),
      storage,
    }).pipe(withStoreCapacity("growth"));

    if (isResponse(record)) return record;
    const reserved = yield* publish(directory, record, "reserve");

    if (!reserved.ok) return canonicalAdmissionUnavailable();

    const result = yield* activate({ proof: proof.value, owns, record, next: digest }).pipe(
      withStoreCapacity("required")
    );

    yield* settle(directory, record, isResponse(result) ? "cancelled" : "committed").pipe(
      Effect.ignore
    );

    if (isResponse(result)) return result;

    return Response.json(
      {
        data: {
          status: "rotated",
          backupRecoveryCode: code,
          rotatedAt: DateTime.formatIso(DateTime.makeUnsafe(result)),
        },
        next: [],
      },
      { headers: { "cache-control": "no-store" } }
    );
  },
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

const pageSize = 16;

export const repairRecoveryAlarm = Effect.fn(function* (
  current: number,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT min(CASE WHEN state='pending' THEN expires_at_ms ELSE ${current} END) AS deadline FROM recovery_rotations`;

  const deadline = yield* Schema.decodeUnknownEffect(Schema.NullOr(Schema.Int))(row?.deadline);

  return deadline === null
    ? false
    : yield* preserveStoreAlarm(storage, Math.max(deadline, current));
});

const settleRotation = Effect.fn(function* (directory: Directory, row: unknown) {
  const sql = yield* SqliteClient;
  const record = yield* Schema.decodeUnknownEffect(RecoveryRotation)(row);

  const [marked] =
    yield* sql`UPDATE recovery_rotations SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE id=${record.id} RETURNING state`;

  if (marked === undefined) return;

  const state = yield* Schema.decodeUnknownEffect(Schema.Literals(["committed", "cancelled"]))(
    marked.state
  );

  yield* settle(directory, record, state);
});

export const recoverRotations = Effect.fn(function* (
  now: number,
  directory: Directory,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;

  const rows =
    yield* sql`SELECT * FROM recovery_rotations WHERE state<>'pending' OR expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${pageSize}`;

  yield* Effect.forEach(rows, (row) => settleRotation(directory, row), { discard: true });

  yield* repairRecoveryAlarm(now, storage);

  return { attempted: rows.length, failed: 0 };
});
