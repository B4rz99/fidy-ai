import { UserId } from "../../src/core/identity/contract";
import { Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { userTrialPeriodQuery } from "../../src/shell/identity/operations";
import { isolatedTestDatabases } from "../d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = UserId.make("10000000-0000-4000-8000-000000000001");
const userB = UserId.make("20000000-0000-4000-8000-000000000002");

it("selects only the explicit User's original trial for a caller-owned statement", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE users (id TEXT PRIMARY KEY, trial_started_at_ms INTEGER, trial_ends_at_ms INTEGER ,service_market TEXT,locale TEXT,time_zone TEXT,created_at_ms INTEGER,verified_email_address TEXT,email_verified_at_ms INTEGER,recovery_code_digest BLOB,recovery_created_at_ms INTEGER,recovery_consumed_at_ms INTEGER,recovery_revision INTEGER,whatsapp_portfolio_id TEXT,whatsapp_bsuid TEXT,whatsapp_verified_at_ms INTEGER,route_portfolio_id TEXT,route_bsuid TEXT,route_phone_number_id TEXT,route_verified_at_ms INTEGER)"
          ),
          db
            .prepare(
              "INSERT INTO users(id,trial_started_at_ms,trial_ends_at_ms) VALUES (?1,100,200)"
            )
            .bind(userA),
          db
            .prepare(
              "INSERT INTO users(id,trial_started_at_ms,trial_ends_at_ms) VALUES (?1,300,400)"
            )
            .bind(userB),
        ])
      );
      const query = userTrialPeriodQuery(userB);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(query.sql)
            .bind(...query.params)
            .first()
        )
      ).toEqual({ startedAtMs: 300, endsAtMs: 400 });
      const missing = userTrialPeriodQuery(UserId.make("30000000-0000-4000-8000-000000000003"));
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(missing.sql)
            .bind(...missing.params)
            .first()
        )
      ).toBeNull();
    })
  ));
