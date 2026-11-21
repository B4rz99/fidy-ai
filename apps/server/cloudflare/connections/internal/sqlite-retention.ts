import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, type Redacted, Result, Schema } from "effect";
import type { ConnectionBankCleanup } from "../contract";
import { newId } from "../../secret-material/operations";
import { preserveStoreAlarm } from "../../runtime/sqlite/operations";
import { Candidate } from "./cleanup";
import { retentionStatements } from "./retention";
import { failed, one } from "./sqlite-browser";
import { grantPurpose, openGrant } from "./grant";

const observableTokens = ["access_token", "refresh_token"] as const;

const leaseMs = 120000;

const retryMs = 300000;

const dayMs = 86400000;

export const repairRetention = Effect.fn(function* (
  storage: DurableObjectStorage,
  cleanupEnabled: boolean
) {
  const sql = yield* SqliteClient;

  const [row] = yield* sql`SELECT min(due) AS due FROM (
    SELECT min(a.expires_at_ms) AS due FROM connection_authorizations b JOIN connection_attempts a ON a.id=b.attempt_id WHERE b.phase!='failed'
    UNION ALL SELECT min(a.expires_at_ms) FROM connection_grants g JOIN connection_attempts a ON a.id=g.attempt_id WHERE g.state IN ('claimed','quarantined')
    UNION ALL SELECT min(expires_at_ms)+${dayMs} FROM connection_attempts a WHERE NOT EXISTS(SELECT 1 FROM connection_authorizations b WHERE b.attempt_id=a.id AND b.consent_id IS NOT NULL)
    UNION ALL SELECT min(cleanup_after_ms) FROM connection_grants WHERE ${Number(cleanupEnabled)} AND state='cleanup_required' AND envelope IS NOT NULL AND cleaned_at_ms IS NULL)
    WHERE NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining')`;

  const value = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ due: Schema.NullOr(Schema.Int) })
  )(row);

  return value.due === null
    ? false
    : yield* preserveStoreAlarm(storage, Math.max(value.due, yield* Clock.currentTimeMillis));
});

export const expireAttempts = Effect.fn(function* (
  storage: DurableObjectStorage,
  now: number,
  cleanupEnabled: boolean
) {
  const sql = yield* SqliteClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if ((yield* sql`SELECT 1 FROM erasure_requests WHERE state<>'Draining' LIMIT 1`).length > 0) {
        return;
      }

      yield* Effect.forEach(
        retentionStatements(now),
        Effect.fnUntraced(function* (statement) {
          yield* sql.unsafe(statement.sql, statement.params);
        }),
        { discard: true }
      );

      yield* repairRetention(storage, cleanupEnabled);
    })
  );

  return { attempted: 0, failed: 0 };
});

type Cleanup = {
  storage: DurableObjectStorage;
  key: Redacted.Redacted<string>;
  bank: ConnectionBankCleanup;
  owns: (id: string) => boolean;
};

const claimCleanup = Effect.fn(function* ({ storage, owns }: Cleanup, now: number, claim: string) {
  const sql = yield* SqliteClient;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows =
        yield* sql`UPDATE connection_grants SET cleanup_claim=${claim},cleanup_after_ms=${now + leaseMs} WHERE attempt_id=(
      SELECT g.attempt_id FROM connection_grants g JOIN connection_attempts a ON a.id=g.attempt_id JOIN connections c ON c.id=a.connection_id JOIN connection_authorizations b ON b.attempt_id=a.id
      WHERE g.state='cleanup_required' AND g.envelope IS NOT NULL AND g.cleaned_at_ms IS NULL AND g.cleanup_after_ms<=${now} AND c.institution_id='bancolombia' AND b.consent_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=c.user_id AND state<>'Draining') ORDER BY g.cleanup_after_ms,g.claimed_at_ms,g.attempt_id LIMIT 1) RETURNING attempt_id`;

      if (rows.length === 0) return Option.none<typeof Candidate.Type>();

      const [raw] =
        yield* sql`SELECT g.attempt_id AS attemptId,a.connection_id AS connectionId,c.user_id AS userId,b.consent_id AS consentId,b.intent_json AS intentJson,g.envelope,g.cleanup_access_seen AS accessSeen,g.cleanup_refresh_seen AS refreshSeen
      FROM connection_grants g JOIN connection_attempts a ON a.id=g.attempt_id JOIN connections c ON c.id=a.connection_id JOIN connection_authorizations b ON b.attempt_id=a.id WHERE g.cleanup_claim=${claim}`;

      const row = yield* Schema.decodeUnknownEffect(Candidate)(raw);

      if (!owns(row.userId)) return yield* failed();
      yield* preserveStoreAlarm(storage, now + leaseMs);

      return Option.some(row);
    })
  );
});

export const cleanupGrant = Effect.fn(function* (input: Cleanup) {
  const { storage, key, bank } = input;
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  const claim = newId();
  const candidate = yield* claimCleanup(input, now, claim);

  if (Option.isNone(candidate)) return { attempted: 0, failed: 0 };
  const row = candidate.value;

  const revoked = yield* Effect.gen(function* () {
    const grant = yield* openGrant({
      key,
      purpose: yield* grantPurpose({ ...row, clientId: bank.clientId }),
      envelope: row.envelope,
    });

    yield* bank.revoke({
      grant,
      observedTokens: observableTokens.filter((token) =>
        token === "access_token" ? row.accessSeen === 1 : row.refreshSeen === 1
      ),
      recordActive: (token) =>
        Effect.gen(function* () {
          yield* one(
            yield* sql`UPDATE connection_grants SET cleanup_access_seen=CASE WHEN ${token}='access_token' THEN 1 ELSE cleanup_access_seen END,cleanup_refresh_seen=CASE WHEN ${token}='refresh_token' THEN 1 ELSE cleanup_refresh_seen END
        WHERE attempt_id=${row.attemptId} AND cleanup_claim=${claim} AND state='cleanup_required' AND envelope=${row.envelope} AND cleaned_at_ms IS NULL AND cleanup_after_ms>${yield* Clock.currentTimeMillis}
        AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining') RETURNING attempt_id`
          );
        }).pipe(Effect.mapError(failed)),
    });
    const completed = yield* Clock.currentTimeMillis;
    yield* one(
      yield* sql`UPDATE connection_grants SET envelope=NULL,expires_at_ms=NULL,cleaned_at_ms=${completed},cleanup_claim=NULL WHERE attempt_id=${row.attemptId} AND cleanup_claim=${claim} AND state='cleanup_required' AND envelope=${row.envelope} AND cleanup_after_ms>${completed}
      AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining') RETURNING attempt_id`
    );
  }).pipe(Effect.timeout("60 seconds"), Effect.result);

  if (Result.isFailure(revoked)) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE connection_grants SET cleanup_claim=NULL,cleanup_after_ms=${now + retryMs} WHERE attempt_id=${row.attemptId} AND cleanup_claim=${claim} AND cleaned_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining')`;
        yield* preserveStoreAlarm(storage, now + retryMs);
      })
    );
  }

  return { attempted: 1, failed: Result.isFailure(revoked) ? 1 : 0 };
});
