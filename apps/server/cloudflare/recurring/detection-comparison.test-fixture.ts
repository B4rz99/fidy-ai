import { DateTime, Effect } from "effect";
import { UserId } from "../../src/core/identity/contract";
import { installTestSchema } from "../d1-test-fixture";

const digestBytes = 32;
const freshLifetimeMs = 600000;
const idleLifetimeMs = 3600000;
const hardLifetimeMs = 7776000000;
const firstYear = 2020;
const monthsPerYear = 12;
const uuidDigits = 12;
const seedBatchSize = 128;
export const userId = UserId.make("14700000-0000-4000-8000-000000000001");
export const session = "14700000-0000-4000-8000-000000000002";
export const digest = new Uint8Array(digestBytes).fill(1);
export const seedDetectionHistory = Effect.fn(function* (
  db: D1Database,
  scenario: Readonly<{ count: number; groups: number }>
) {
  yield* Effect.tryPromise(() => installTestSchema({ db }));
  const now = DateTime.nowUnsafe().epochMilliseconds;
  yield* Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)"
        )
        .bind(userId),
      db
        .prepare(
          "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES('processing_grant',?,?,'{}','disclosure','decision',0,0)"
        )
        .bind(userId, userId),
      db
        .prepare(
          "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,'ABCD-1234',?,?,'consumed',?,?)"
        )
        .bind(session, digest, userId, now, now + freshLifetimeMs),
      db
        .prepare(
          "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,?,?,?,?,?)"
        )
        .bind(
          session,
          session,
          userId,
          digest,
          now,
          now + freshLifetimeMs,
          now + idleLifetimeMs,
          now + hardLifetimeMs
        ),
    ])
  );
  const statements = Array.from({ length: scenario.count }, (_, index) =>
    transactionStatement(db, scenario, index)
  );
  for (let offset = 0; offset < statements.length; offset += seedBatchSize) {
    yield* Effect.tryPromise(() => db.batch(statements.slice(offset, offset + seedBatchSize)));
  }
});

const transactionStatement = (
  db: D1Database,
  scenario: Readonly<{ count: number; groups: number }>,
  index: number
): D1PreparedStatement => {
  const month = Math.floor(index / scenario.groups);
  const year = firstYear + Math.floor(month / monthsPerYear);
  const occurred = DateTime.makeUnsafe(
    `${year}-${String((month % monthsPerYear) + 1).padStart(2, "0")}-15T12:00:00.007Z`
  ).epochMilliseconds;
  return db
    .prepare(
      "INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms) VALUES(?,?,?,?,'outflow',?,'10000000-0000-4000-8000-000000000016',?,?)"
    )
    .bind(
      `14700000-0000-4000-8000-${String(index + 100).padStart(uuidDigits, "0")}`,
      userId,
      `100.0${(month % 4) + 1}`,
      (index % scenario.groups) % 2 === 0 ? "COP" : "USD",
      `Provider ${String(index % scenario.groups).padStart(3, "0")}`,
      occurred,
      occurred
    );
};
