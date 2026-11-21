import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import { expirePATConsents, expirePairingConsents } from "../../../src/shell/consent/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import {
  expireApprovedPairings,
  expireFixedPATs,
  expiredPATGrants,
  expiredPairingGrants,
} from "../../../src/shell/tokens/operations";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { PATUnavailable } from "../contract";

const pageSize = 32;

export const repairPATExpiry = Effect.fn(function* (
  current: number,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;

  const [row] = yield* sql`SELECT min(deadline) AS deadline FROM(
      SELECT min(expires_at_ms) AS deadline FROM pats WHERE revoked_at_ms IS NULL
      UNION ALL SELECT min(expires_at_ms) FROM pat_pairings WHERE state='approved_awaiting_claim' UNION ALL SELECT min(expires_at_ms) FROM pat_review_events)`;

  const { deadline } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ deadline: Schema.OptionFromNullOr(Schema.Int) })
  )(row);

  return Option.isSome(deadline)
    ? yield* preserveStoreAlarm(storage, Math.max(current, deadline.value))
    : false;
});

const expire = Effect.fn(function* (
  selected: OwnedStatement,
  evidence: OwnedStatement,
  transition: OwnedStatement
) {
  const sql = yield* SqliteClient;
  const candidates = yield* sql.unsafe(selected.sql, selected.params);

  if (candidates.length === 0) return 0;
  const recorded = yield* sql.unsafe(evidence.sql + " RETURNING id", evidence.params);
  const closed = yield* sql.unsafe(transition.sql + " RETURNING id", transition.params);

  if (recorded.length !== candidates.length || closed.length !== recorded.length) {
    return yield* new PATUnavailable({ cause: Option.none() });
  }

  return closed.length;
});

export const sweepPATExpiry = Effect.fn(function* (current: number, storage: DurableObjectStorage) {
  const pairs = expiredPairingGrants({ current, limit: pageSize }),
    pats = expiredPATGrants({ current, limit: pageSize });

  return yield* Effect.gen(function* () {
    const approvals = yield* expire(
      pairs.statement,
      expirePairingConsents({ current, candidates: pairs }),
      expireApprovedPairings(current)
    );

    const tokens = yield* expire(
      pats.statement,
      expirePATConsents({ current, candidates: pats }),
      expireFixedPATs(current)
    );

    const sql = yield* SqliteClient;
    yield* sql`DELETE FROM pat_review_events WHERE id IN(SELECT id FROM pat_review_events WHERE expires_at_ms<=${current} ORDER BY expires_at_ms LIMIT ${pageSize})`;
    yield* repairPATExpiry(current, storage);

    return { attempted: approvals + tokens, failed: 0 };
  }).pipe(withStoreCapacity("required"));
});
