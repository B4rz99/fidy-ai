import { browserSessionBindingHeader } from "~/shell/browser-transport/contract";
import { afterAll, expect, it } from "@effect/vitest";
import { BigDecimal, Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { BrowserSessionBinding } from "../../src/shell/web-session/contract";

import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { initialBrowserSessionBindingResponse } from "./internal/browser-entry";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const current = 1_000_000;
const freshDuration = 600_000;
const hardDuration = 7_776_000_000;
const origin = "https://app.fidyapp.com";
const identities = [
  {
    user: "10000000-0000-4000-8000-000000000001",
    session: "20000000-0000-4000-8000-000000000001",
    pairing: "30000000-0000-4000-8000-000000000001",
    consent: "40000000-0000-4000-8000-000000000001",
    transaction: "50000000-0000-4000-8000-000000000001",
    token: "a".repeat(43),
    zone: "America/Bogota",
    amount: "111",
  },
  {
    user: "10000000-0000-4000-8000-000000000002",
    session: "20000000-0000-4000-8000-000000000002",
    pairing: "30000000-0000-4000-8000-000000000002",
    consent: "40000000-0000-4000-8000-000000000002",
    transaction: "50000000-0000-4000-8000-000000000002",
    token: "b".repeat(43),
    zone: "UTC",
    amount: "222",
  },
] as const;
const setup = Effect.fnUntraced(function* () {
  const db = yield* Effect.tryPromise(() => databases.acquire());
  yield* Effect.tryPromise(() => installTestSchema({ db }));
  const disclosure = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
    currentDisclosureFor()
  );
  for (const [index, identity] of identities.entries()) {
    const digest = new Uint8Array(
      yield* Effect.tryPromise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity.token))
      )
    );
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms) VALUES (?,'CO','es-CO',?,?,?,?)"
          )
          .bind(identity.user, identity.zone, current, current, current + 604800000),
        db
          .prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,?,?,?,'consumed',?,?)"
          )
          .bind(
            identity.pairing,
            `TEST0000${index}`,
            digest,
            identity.user,
            current,
            current + freshDuration
          ),
        db
          .prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)"
          )
          .bind(
            identity.session,
            identity.pairing,
            identity.user,
            digest,
            current,
            current + freshDuration,
            current + freshDuration,
            current + hardDuration
          ),
        db
          .prepare(
            "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?,?,?,?,?,?,?)"
          )
          .bind(
            identity.consent,
            identity.user,
            disclosure,
            `disclosure-${index}`,
            `decision-${index}`,
            current,
            current
          ),
        db
          .prepare(
            "INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms) VALUES (?,?,?,'COP','outflow',?,'10000000-0000-4000-8000-000000000016',?,?)"
          )
          .bind(
            identity.transaction,
            identity.user,
            identity.amount,
            `Only User ${index}`,
            current,
            current
          ),
      ])
    );
  }
  yield* TestClock.setTime(current);
  return db;
});
const entry = ({
  db,
  context,
  token,
  binding,
}: Readonly<{
  db: D1Database;
  context: "application" | "transactions";
  token: string;
  binding: Option.Option<string>;
}>): ReturnType<typeof initialBrowserSessionBindingResponse> => {
  const headers = new Headers({ origin, cookie: `__Host-fidy_session=${token}` });
  if (Option.isSome(binding)) headers.set(browserSessionBindingHeader, binding.value);
  return initialBrowserSessionBindingResponse({
    db,
    browserOrigin: origin,
    request: new Request(`https://api.fidyapp.com/web/session/binding?context=${context}`, {
      headers,
    }),
  });
};
for (const context of ["application", "transactions"] as const) {
  it.effect(
    `${context} cookie-only entry discloses only the presented User's profile and history`,
    () =>
      Effect.gen(function* () {
        const db = yield* setup();
        for (const identity of identities) {
          const response = Option.getOrThrow(
            yield* entry({ db, context, token: identity.token, binding: Option.none() })
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
          const body = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(BrowserSessionBinding))(
            yield* Effect.tryPromise(() => response.json())
          );
          expect(body.binding).toBe(identity.session);
          const initial = Option.getOrThrow(body.initial);
          expect(initial.status).toBe("Granted");
          if (initial.status !== "Granted") return yield* Effect.die("Expected Granted fixture");
          expect(initial.profile.data.id).toBe(identity.user);
          expect(initial.profile.data.timeZone).toBe(identity.zone);
          if (context === "transactions") {
            expect(
              Option.getOrThrow(initial.transactions).page.data.map((row) => ({
                id: row.id,
                amount: BigDecimal.format(row.money.amount),
                currency: row.money.currency,
              }))
            ).toEqual([{ id: identity.transaction, amount: identity.amount, currency: "COP" }]);
          } else expect(Option.isNone(initial.transactions)).toBe(true);
        }
        const audits = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT user_id,record_type FROM audit_entries ORDER BY user_id,record_type")
            .all()
        );
        expect(audits.results).toEqual(
          identities.flatMap((identity) =>
            context === "transactions"
              ? [
                  { user_id: identity.user, record_type: "identity_read" },
                  { user_id: identity.user, record_type: "session_call" },
                ]
              : [{ user_id: identity.user, record_type: "identity_read" }]
          )
        );
      })
  );
  it.effect(
    `${context} refuses User A's binding with User B's cookie without renewal or Audit`,
    () =>
      Effect.gen(function* () {
        const db = yield* setup();
        const before = yield* Effect.tryPromise(() =>
          db.prepare("SELECT id,idle_expires_at_ms FROM web_sessions ORDER BY id").all()
        );
        const response = Option.getOrThrow(
          yield* entry({
            db,
            context,
            token: identities[1].token,
            binding: Option.some(identities[0].session),
          })
        );
        expect(response.status).toBe(403);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT id,idle_expires_at_ms FROM web_sessions ORDER BY id").all()
          )
        ).toMatchObject({ results: before.results });
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT COUNT(*) AS count FROM audit_entries").first()
          )
        ).toEqual({ count: 0 });
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT COUNT(*) AS count FROM canonical_request_leases").first()
          )
        ).toEqual({ count: 0 });
      })
  );
}
