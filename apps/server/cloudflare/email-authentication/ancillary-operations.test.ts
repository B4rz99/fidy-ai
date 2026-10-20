import { emailPairingAllowsUser } from "../../src/shell/email-authentication/operations";
import { afterAll, expect, it } from "vitest";
import { Clock, Effect, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";
import {
  consentHistoryTestSchema,
  installCurrentTestObjects,
  isolatedTestDatabases,
} from "../d1-test-fixture";
import { freshSessionQuery } from "../../src/shell/web-session/operations";
import { protectConsentStatement } from "../../src/shell/consent/operations";
import {
  prepareEmailPendingWorkObservation,
  prepareEmailRejectedWorkObservation,
  verifiedEmailQuery,
} from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = UserId.make("10000000-0000-4000-8000-000000000001");
const userB = UserId.make("10000000-0000-4000-8000-000000000002");
const sessionId = "20000000-0000-4000-8000-000000000001";
const pairingId = "30000000-0000-4000-8000-000000000001";

it("rechecks one User's current mailbox, fresh session and Consent in the protected statement", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installCurrentTestObjects({ db, tables: [] }));
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,service_market TEXT,locale TEXT,time_zone TEXT,created_at_ms INTEGER,verified_email_address TEXT,email_verified_at_ms INTEGER,recovery_code_digest BLOB,recovery_created_at_ms INTEGER,recovery_consumed_at_ms INTEGER,recovery_revision INTEGER,whatsapp_portfolio_id TEXT,whatsapp_bsuid TEXT,whatsapp_verified_at_ms INTEGER,route_portfolio_id TEXT,route_bsuid TEXT,route_phone_number_id TEXT,route_verified_at_ms INTEGER)"
          ),
          db.prepare(
            "CREATE TABLE web_sessions (id TEXT, user_id TEXT, revoked_at_ms INTEGER, fresh_until_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER)"
          ),
          db.prepare(consentHistoryTestSchema),
          db
            .prepare(
              "WITH incoming(user_id,email_address) AS (VALUES (?, 'current@example.com'), (?, 'foreign@example.com')) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,verified_email_address,email_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.email_address,0 FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET verified_email_address=excluded.verified_email_address,email_verified_at_ms=excluded.email_verified_at_ms"
            )
            .bind(userA, userB),
          db
            .prepare(
              "INSERT INTO consent_history (record_type,user_id) VALUES ('processing_grant',?)"
            )
            .bind(userA),
        ])
      );
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO web_sessions VALUES (?, ?, NULL, ?, ?, ?)")
          .bind(sessionId, userA, now + 1_000, now + 1_000, now + 1_000)
          .run()
      );
      const session = freshSessionQuery({
        subject: { sql: "SELECT ? AS sessionId, ? AS userId", params: [sessionId, userA] },
        current: now,
      });
      const email = verifiedEmailQuery({ userId: userA });
      const guarded = protectConsentStatement({
        statement: {
          sql: `SELECT email.emailAddress FROM (${session.sql}) AS session JOIN (${email.sql}) AS email ON email.userId = session.userId WHERE 1 = 1`,
          params: [...session.params, ...email.params],
        },
        subject: { _tag: "User", userId: userA },
        requirement: "granted",
      });
      const statement = db.prepare(guarded.sql).bind(...guarded.params);
      expect(yield* Effect.tryPromise(() => statement.first())).toEqual({
        emailAddress: "current@example.com",
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE users SET verified_email_address = 'replacement@example.com' WHERE id = ?"
          )
          .bind(userA)
          .run()
      );
      expect(yield* Effect.tryPromise(() => statement.first())).toEqual({
        emailAddress: "replacement@example.com",
      });
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE web_sessions SET fresh_until_ms = ?").bind(now).run()
      );
      expect(yield* Effect.tryPromise(() => statement.first())).toBeNull();
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE web_sessions SET fresh_until_ms = ?")
          .bind(now + 1_000)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "DELETE FROM consent_history AS onboarding_consent_records WHERE onboarding_consent_records.record_type='processing_grant' AND user_id = ?"
          )
          .bind(userA)
          .run()
      );
      expect(yield* Effect.tryPromise(() => statement.first())).toBeNull();
    })
  ));

it("keeps an unclaimed or same-User pairing eligible while a foreign email proof blocks its update", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE browser_login_pairings (email_work_id TEXT,email_user_id TEXT,id TEXT, user_id TEXT)"
          ),
          db.prepare("INSERT INTO browser_login_pairings(id) VALUES (?)").bind(pairingId),
        ])
      );
      const allowed = emailPairingAllowsUser({
        subject: {
          sql: "SELECT browser_login_pairings.id AS pairingId, ? AS userId",
          params: [userA],
        },
      });
      const update = db
        .prepare(
          `UPDATE browser_login_pairings SET user_id = ? WHERE id = ? AND EXISTS (${allowed.sql})`
        )
        .bind(userA, pairingId, ...allowed.params);
      expect((yield* Effect.tryPromise(() => update.run())).meta.changes).toBe(1);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE browser_login_pairings SET email_work_id=id,email_user_id=?2 WHERE id=?1"
          )
          .bind(pairingId, userA)
          .run()
      );
      expect((yield* Effect.tryPromise(() => update.run())).meta.changes).toBe(1);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE browser_login_pairings AS browser_pairing_email_proofs SET email_user_id = ? WHERE email_work_id IS NOT NULL "
          )
          .bind(userB)
          .run()
      );
      expect((yield* Effect.tryPromise(() => update.run())).meta.changes).toBe(0);
    })
  ));

it("bounds email health samples and releases no mailbox, proof or provider fields", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TABLE email_replacements (work_id TEXT, created_at_ms INTEGER, expires_at_ms INTEGER, state TEXT, email_address TEXT, proof_digest TEXT, provider_message_id TEXT)"
          )
          .run()
      );
      yield* Effect.tryPromise(() =>
        db.batch(
          Array.from({ length: 20 }, (_, index) =>
            db
              .prepare(
                "INSERT INTO email_replacements VALUES (?, ?, ?, ?, 'private@example.com', 'private-proof', 'private-provider')"
              )
              .bind(
                `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
                index,
                1_000,
                index < 10 ? "awaiting_delivery" : "rejected"
              )
          )
        )
      );
      const input = { db, operation: "emailReplacement" as const, limit: 8 };
      const pending = yield* Effect.tryPromise(() =>
        prepareEmailPendingWorkObservation(input).all()
      );
      expect(pending.results).toHaveLength(8);
      expect(pending.results[0]).toEqual({
        id: "40000000-0000-4000-8000-000000000000",
        created: 0,
        deadline: 1_000,
      });
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(pending.results)
      ).not.toContain("private");
      expect(
        yield* Effect.tryPromise(() =>
          prepareEmailRejectedWorkObservation({ ...input, sinceMs: 0 }).first()
        )
      ).toEqual({ count: 8 });
      expect(
        yield* Effect.tryPromise(() =>
          prepareEmailRejectedWorkObservation({ ...input, sinceMs: 18 }).first()
        )
      ).toEqual({ count: 2 });
      expect(() => prepareEmailPendingWorkObservation({ ...input, limit: 9 })).toThrow();
      expect(() =>
        prepareEmailRejectedWorkObservation({ ...input, sinceMs: 0, limit: 0 })
      ).toThrow();
    })
  ));
