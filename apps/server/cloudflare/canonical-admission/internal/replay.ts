import { Effect, Option, Schema } from "effect";
import { CanonicalAdmissionUnavailable } from "../contract";
import { canonicalRetryLifetimeMs } from "../../../src/core/quotas/contract";

const Replay = Schema.Struct({
  operation: Schema.String,
  inputHash: Schema.String,
  state: Schema.Literals(["pending", "completed"]),
  expiresAt: Schema.Int,
  status: Schema.OptionFromNullOr(Schema.Int),
  body: Schema.OptionFromNullOr(Schema.String),
  contentType: Schema.OptionFromNullOr(Schema.String),
});
export type Replay = typeof Replay.Type;

/** Read only live exact-User retained outcomes; the coordinator rechecks authority before disclosure. */
export const retainedReplay = ({
  db,
  userId,
  retryKey,
  current,
}: Readonly<{ db: D1Database; userId: string; retryKey: string; current: number }>): Effect.Effect<
  Option.Option<Replay>,
  CanonicalAdmissionUnavailable
> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `SELECT operation,input_digest AS inputHash,state,expires_at_ms AS expiresAt,status,body,content_type AS contentType FROM canonical_request_replays WHERE user_id = ? AND retry_key_digest = ? AND expires_at_ms > ?`
        )
        .bind(userId, retryKey, current)
        .first<unknown>(),
    catch: (cause) => new CanonicalAdmissionUnavailable({ cause }),
  }).pipe(
    Effect.map((row) =>
      row === null ? Option.none() : Option.some(Schema.decodeUnknownSync(Replay)(row))
    )
  );

/** Claim participates in the same D1 acceptance batch as canonical allowance consumption. */
export const claimReplay = ({
  db,
  userId,
  retryKey,
  operation,
  inputHash,
  identity,
  current,
}: Readonly<{
  db: D1Database;
  userId: string;
  retryKey: string;
  operation: string;
  inputHash: string;
  identity: string;
  current: number;
}>): ReadonlyArray<D1PreparedStatement> => [
  db
    .prepare(
      "DELETE FROM canonical_request_replays WHERE user_id = ? AND retry_key_digest = ? AND expires_at_ms <= ?"
    )
    .bind(userId, retryKey, current),
  db
    .prepare(
      "INSERT INTO canonical_request_replays (user_id,retry_key_digest,operation,input_digest,identity,accepted_at_ms,expires_at_ms,state) VALUES (?,?,?,?,?,?,?,'pending')"
    )
    .bind(
      userId,
      retryKey,
      operation,
      inputHash,
      identity,
      current,
      current + canonicalRetryLifetimeMs
    ),
];

/** Finishing never extends the original 24-hour window. Pending claims cannot execute fresh work. */
export const completeReplay = ({
  db,
  userId,
  retryKey,
  identity,
  response,
  body,
}: Readonly<{
  db: D1Database;
  userId: string;
  retryKey: string;
  identity: string;
  response: Response;
  body: string;
}>): D1PreparedStatement =>
  db
    .prepare(
      "UPDATE canonical_request_replays SET state = 'completed',status = ?,body = ?,content_type = ? WHERE user_id = ? AND retry_key_digest = ? AND identity = ? AND state = 'pending'"
    )
    .bind(response.status, body, response.headers.get("content-type"), userId, retryKey, identity);
