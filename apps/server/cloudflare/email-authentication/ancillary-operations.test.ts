import { emailPairingAllowsUser } from "../../src/shell/email-authentication/operations";
import { afterAll, expect, it } from "vitest";
import { Clock, Effect, Exit, Option, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";
import {
  PendingConsentExchangeId,
  Sha256Digest,
  WhatsAppProviderMessageId,
} from "../../src/shell/consent/contract";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { freshSessionQuery } from "../../src/shell/web-session/operations";
import { protectConsentStatement } from "../../src/shell/consent/operations";
import {
  findOnboardingEmailReplay,
  prepareEmailPendingWorkObservation,
  prepareEmailRejectedWorkObservation,
  readOnboardingEmailStatus,
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
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("CREATE TABLE verified_email_credentials (user_id TEXT, email_address TEXT)"),
          db.prepare(
            "CREATE TABLE web_sessions (id TEXT, user_id TEXT, revoked_at_ms INTEGER, fresh_until_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER)"
          ),
          db.prepare("CREATE TABLE onboarding_consent_records (user_id TEXT)"),
          db
            .prepare(
              "INSERT INTO verified_email_credentials VALUES (?, 'current@example.com'), (?, 'foreign@example.com')"
            )
            .bind(userA, userB),
          db.prepare("INSERT INTO onboarding_consent_records VALUES (?)").bind(userA),
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
            "UPDATE verified_email_credentials SET email_address = 'replacement@example.com' WHERE user_id = ?"
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
        db.prepare("DELETE FROM onboarding_consent_records WHERE user_id = ?").bind(userA).run()
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
          db.prepare("CREATE TABLE browser_pairing_email_proofs (pairing_id TEXT, user_id TEXT)"),
          db.prepare("CREATE TABLE browser_login_pairings (id TEXT, user_id TEXT)"),
          db.prepare("INSERT INTO browser_login_pairings VALUES (?, NULL)").bind(pairingId),
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
          .prepare("INSERT INTO browser_pairing_email_proofs VALUES (?, ?)")
          .bind(pairingId, userA)
          .run()
      );
      expect((yield* Effect.tryPromise(() => update.run())).meta.changes).toBe(1);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE browser_pairing_email_proofs SET user_id = ?").bind(userB).run()
      );
      expect((yield* Effect.tryPromise(() => update.run())).meta.changes).toBe(0);
    })
  ));

it("distinguishes missing enrollment from matching, conflicting and unreadable replay evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TABLE pending_email_enrollments (exchange_id TEXT, submission_message_id TEXT, submission_body_sha256 TEXT, state TEXT)"
          )
          .run()
      );
      const input = {
        db,
        exchangeId: PendingConsentExchangeId.make(pairingId),
        submissionMessageId: WhatsAppProviderMessageId.make("wamid.mailbox"),
        submissionBodySha256: Sha256Digest.make("a".repeat(64)),
      };
      expect(Option.isNone(yield* findOnboardingEmailReplay(input))).toBe(true);
      expect(yield* readOnboardingEmailStatus(input)).toBe("awaiting_email");
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO pending_email_enrollments VALUES (?, ?, ?, 'awaiting_proof')")
          .bind(input.exchangeId, input.submissionMessageId, input.submissionBodySha256)
          .run()
      );
      expect(yield* findOnboardingEmailReplay(input)).toEqual(Option.some("matching"));
      expect(
        yield* findOnboardingEmailReplay({
          ...input,
          submissionBodySha256: Sha256Digest.make("b".repeat(64)),
        })
      ).toEqual(Option.some("conflict"));
      expect(yield* readOnboardingEmailStatus(input)).toBe("awaiting_proof");
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE pending_email_enrollments SET submission_body_sha256 = 'invalid', state = 'unknown'"
          )
          .run()
      );
      expect(Exit.isFailure(yield* Effect.exit(findOnboardingEmailReplay(input)))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(readOnboardingEmailStatus(input)))).toBe(true);
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
