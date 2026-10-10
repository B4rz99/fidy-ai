import { ConsentRecordId, OnboardingConsentGrantId } from "../../src/core/consent/contract";
import { UserId } from "../../src/core/identity/contract";
import { Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import {
  prepareConsentAction,
  readConsentStanding,
  readConsentStatus,
  recordConsentRevocation,
  recordWebOnboardingConsent,
} from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = "10000000-0000-4000-8000-000000000001";
const userB = "20000000-0000-4000-8000-000000000002";
const grantA = "30000000-0000-4000-8000-000000000001";
const now = 1_800_000_000_000;
const setup = (): Promise<D1Database> =>
  databases.acquire().then((db) =>
    installTestSchema({
      db,
      sources: [
        "0003_pending_consent",
        "0004_onboarding_email",
        "0005_verified_onboarding",
        "0006_browser_login",
        "0009_transactions",
        "0010_pat_lifecycle",
      ].map((name) => new URL(`../migrations/${name}.sql`, import.meta.url)),
    }).then(() => db)
  );

it("reads one User's exact Consent basis without borrowing another User's grant", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      const disclosure = currentDisclosureFor();
      const disclosureJson = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
        disclosure
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("INSERT INTO users VALUES (?,'CO','es-CO','America/Bogota',?)")
            .bind(userA, now),
          db
            .prepare("INSERT INTO users VALUES (?,'CO','es-CO','America/Bogota',?)")
            .bind(userB, now),
          db
            .prepare(
              `INSERT INTO onboarding_consent_records VALUES (?, ?, ?, 'disclosed', 'accepted', ?, ?)`
            )
            .bind(grantA, userA, disclosureJson, now, now),
        ])
      );
      expect(yield* readConsentStanding({ db, userId: userA })).toEqual({
        _tag: "Granted",
        subjectUserId: userA,
        basis: {
          grantId: grantA,
          disclosureRevision: disclosure.revision,
          disclosureSha256: disclosure.contentSha256,
          policyRevision: disclosure.policy.revision,
          policySha256: disclosure.policy.contentSha256,
        },
      });
      expect(yield* readConsentStanding({ db, userId: userB })).toEqual({
        _tag: "Missing",
        subjectUserId: userB,
      });
    })
  ));

const sessionA = "40000000-0000-4000-8000-000000000001";
const sessionB = "40000000-0000-4000-8000-000000000002";
const seedSubject = ({
  db,
  userId,
  sessionId,
  index,
}: Readonly<{
  db: D1Database;
  userId: string;
  sessionId: string;
  index: number;
}>): Promise<void> => {
  const pairingId = `50000000-0000-4000-8000-00000000000${index}`;
  return db
    .batch([
      db.prepare("INSERT INTO users VALUES (?,'CO','es-CO','America/Bogota',?)").bind(userId, now),
      db
        .prepare(
          `INSERT INTO onboarding_consent_records VALUES (?, ?, ?, 'disclosed', 'accepted', ?, ?)`
        )
        .bind(
          index === 1 ? grantA : "30000000-0000-4000-8000-000000000002",
          userId,
          Schema.encodeSync(Schema.fromJsonString(DisclosureSnapshot))(currentDisclosureFor()),
          now,
          now
        ),
      db
        .prepare(`INSERT INTO browser_login_pairings
      (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?, 'consumed', ?, ?)`)
        .bind(
          pairingId,
          `BCDF-GHJ${index}`,
          new Uint8Array(32).fill(index),
          userId,
          now,
          now + 600_000
        ),
      db
        .prepare(`INSERT INTO web_sessions
      (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          sessionId,
          pairingId,
          userId,
          new Uint8Array(32).fill(index),
          now,
          now + 600_000,
          now + 2_592_000_000,
          now + 7_776_000_000
        ),
    ])
    .then(() => undefined);
};

it("keeps withdrawal and protected actions User-scoped and rolls evidence back with its caller's unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() =>
        seedSubject({ db, userId: userA, sessionId: sessionA, index: 1 })
      );
      yield* Effect.tryPromise(() =>
        seedSubject({ db, userId: userB, sessionId: sessionB, index: 2 })
      );
      const revoke = (id: string): D1PreparedStatement =>
        recordConsentRevocation({
          db,
          subject: { id: sessionA, userId: userA, digest: new Uint8Array(32).fill(1) },
          evidenceId: id,
          current: now + 1,
        });
      const foreign = yield* Effect.tryPromise(() =>
        recordConsentRevocation({
          db,
          subject: { id: sessionB, userId: userA, digest: new Uint8Array(32).fill(2) },
          evidenceId: "foreign",
          current: now + 1,
        }).run()
      );
      expect(foreign.meta.changes).toBe(0);
      const failed = yield* Effect.tryPromise(() =>
        db.batch([
          revoke("rollback"),
          db.prepare("INSERT INTO users SELECT * FROM users WHERE id = ?").bind(userA),
        ])
      ).pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      expect(yield* readConsentStatus({ db, userId: userA })).toBe("Granted");
      yield* Effect.tryPromise(() => revoke("withdrawal").run());
      expect((yield* readConsentStanding({ db, userId: userA }))._tag).toBe("Revoked");
      expect(yield* readConsentStatus({ db, userId: userB })).toBe("Granted");
      expect((yield* Effect.tryPromise(() => revoke("replay").run())).meta.changes).toBe(0);
      const protectedWrite = (userId: string): D1PreparedStatement =>
        prepareConsentAction({
          db,
          statement: {
            sql: "UPDATE users SET time_zone = 'Etc/UTC' WHERE id = ?",
            params: [userId],
          },
          subject: { _tag: "Owner", column: "users.id" },
          requirement: "active",
        });
      expect((yield* Effect.tryPromise(() => protectedWrite(userA).run())).meta.changes).toBe(0);
      expect((yield* Effect.tryPromise(() => protectedWrite(userB).run())).meta.changes).toBe(1);
    })
  ));

it("reads the exact provider-signup grant whose identifier is an opaque authentication attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      const attemptId = "a".repeat(43);
      const disclosure = currentDisclosureFor();
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("INSERT INTO users VALUES (?,'CO','es-CO','America/Bogota',?)")
            .bind(userA, now),
          recordWebOnboardingConsent({
            db,
            userId: UserId.make(userA),
            attemptId,
            disclosure,
            acceptedAtMs: now,
          }),
        ])
      );
      expect(yield* readConsentStanding({ db, userId: userA })).toEqual({
        _tag: "Granted",
        subjectUserId: userA,
        basis: {
          grantId: attemptId,
          disclosureRevision: disclosure.revision,
          disclosureSha256: disclosure.contentSha256,
          policyRevision: disclosure.policy.revision,
          policySha256: disclosure.policy.contentSha256,
        },
      });
    })
  ));

it("keeps canonical Consent identifiers UUID-only and rejects malformed onboarding grant references", () => {
  expect(Schema.is(OnboardingConsentGrantId)(grantA)).toBe(true);
  expect(Schema.is(OnboardingConsentGrantId)("a".repeat(43))).toBe(true);
  expect(Schema.is(ConsentRecordId)("a".repeat(43))).toBe(false);
  for (const value of ["a".repeat(42), "a".repeat(44), "!".repeat(43), "arbitrary-id"]) {
    expect(Schema.is(OnboardingConsentGrantId)(value)).toBe(false);
  }
});
