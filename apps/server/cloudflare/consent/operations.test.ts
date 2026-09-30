import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { Effect, Option, Schema } from "effect";
import { consentNotRevoked } from "@fidy/server/consent-runtime";
import { recordOnboardingConsent } from "@fidy/server/consent-operations";
import { readHostedConsent } from "./operations";
import { currentDisclosureFor } from "@fidy/server/consent-ingress";
import { DisclosureSnapshot } from "@fidy/server/consent-contract";

const instances: Array<Miniflare> = [];
afterEach(() =>
  Effect.runPromise(
    Effect.forEach(instances.splice(0), (instance) => Effect.tryPromise(() => instance.dispose()), {
      discard: true,
    })
  )
);

it("does not expose another User's hosted Consent basis through a substituted credential", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database;
      const userA = "10000000-0000-4000-8000-000000000001";
      const userB = "20000000-0000-4000-8000-000000000002";
      const grantA = "30000000-0000-4000-8000-000000000003";
      const disclosure = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
      )(currentDisclosureFor());
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE users (id TEXT PRIMARY KEY, service_market TEXT, locale TEXT, time_zone TEXT)"
          ),
          db.prepare(
            "CREATE TABLE onboarding_consent_records (id TEXT PRIMARY KEY, user_id TEXT UNIQUE, disclosure_json TEXT)"
          ),
          db.prepare("CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY)"),
          db.prepare("CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT)"),
          db.prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota')").bind(userA),
          db
            .prepare("INSERT INTO onboarding_consent_records VALUES (?, ?, ?)")
            .bind(grantA, userA, disclosure),
          db.prepare("INSERT INTO web_sessions VALUES ('session-b', ?)").bind(userB),
        ])
      );
      const authority = {
        table: "web_sessions" as const,
        predicate: "id = ? AND user_id = ?",
        bindings: ["session-b", userB],
      };
      expect(Option.isNone(yield* readHostedConsent({ db, userId: userA, authority }))).toBe(true);
      yield* Effect.tryPromise(() =>
        db.prepare("INSERT INTO web_sessions VALUES ('session-a', ?)").bind(userA).run()
      );
      const accepted = yield* readHostedConsent({
        db,
        userId: userA,
        authority: { ...authority, bindings: ["session-a", userA] },
      });
      expect(Option.isSome(accepted)).toBe(true);
      if (Option.isSome(accepted)) {
        expect(accepted.value.consentBasis.grantId).toBe(grantA);
        expect(accepted.value.revoked).toBe(false);
      }
    })
  ));

const database = Effect.gen(function* () {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          name: "consent",
          type: "worker",
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "consent", type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch(){return new Response('ok')}}",
                type: "esm",
              },
            },
          },
        },
      },
    ],
  });
  instances.push(instance);
  yield* Effect.tryPromise(() => instance.ready);
  return yield* Effect.tryPromise(() => instance.getD1Database("DB"));
});

it("rechecks the explicit User's Consent in the same D1 unit as protected work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database;
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY)"),
          db.prepare("CREATE TABLE protected_work (user_id TEXT PRIMARY KEY)"),
        ])
      );
      const protectedAction = (userId: string): D1PreparedStatement =>
        db
          .prepare(`INSERT INTO protected_work (user_id) SELECT ? WHERE ${consentNotRevoked("?")}`)
          .bind(userId, userId);
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("INSERT INTO consent_user_revocations (user_id) VALUES (?)").bind("user-a"),
          protectedAction("user-a"),
          protectedAction("user-b"),
        ])
      );
      const result = yield* Effect.tryPromise(() =>
        db.prepare("SELECT user_id FROM protected_work").all()
      );
      expect(result.results).toEqual([{ user_id: "user-b" }]);
    })
  ));

it("copies the exact accepted decision for the explicit User and rolls it back with failed onboarding", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database;
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(`CREATE TABLE pending_consent_decisions (
        exchange_id TEXT PRIMARY KEY, decision TEXT, disclosure_json TEXT, disclosure_message_id TEXT,
        decision_message_id TEXT, received_at_ms INTEGER, occurred_at_ms INTEGER)`),
          db.prepare(`CREATE TABLE onboarding_consent_records (
        id TEXT PRIMARY KEY, user_id TEXT UNIQUE, disclosure_json TEXT, disclosure_message_id TEXT,
        decision_message_id TEXT, decision_received_at_ms INTEGER, accepted_at_ms INTEGER)`),
          db.prepare(`INSERT INTO pending_consent_decisions VALUES
        ('exchange-a', 'accepted', '{"historical":"exact"}', 'disclosure-a', 'decision-a', 200, 100),
        ('exchange-b', 'declined', '{"historical":"declined"}', 'disclosure-b', 'decision-b', 400, 300)`),
        ])
      );
      const grant = recordOnboardingConsent({ userId: "user-a", exchangeId: "exchange-a" });
      const declined = recordOnboardingConsent({ userId: "user-b", exchangeId: "exchange-b" });
      const failed = yield* Effect.result(
        Effect.tryPromise(() =>
          db.batch([
            db.prepare(grant.sql).bind(...grant.params),
            db.prepare("INSERT INTO missing_owner_table VALUES (1)"),
          ])
        )
      );
      expect(failed._tag).toBe("Failure");
      const absent = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM onboarding_consent_records").all()
      );
      expect(absent.results).toEqual([]);
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(grant.sql).bind(...grant.params),
          db.prepare(declined.sql).bind(...declined.params),
        ])
      );
      const stored = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM onboarding_consent_records").all()
      );
      expect(stored.results).toEqual([
        {
          id: "exchange-a",
          user_id: "user-a",
          disclosure_json: '{"historical":"exact"}',
          disclosure_message_id: "disclosure-a",
          decision_message_id: "decision-a",
          decision_received_at_ms: 200,
          accepted_at_ms: 100,
        },
      ]);
    })
  ));
