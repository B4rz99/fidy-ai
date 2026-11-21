import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Exit, Schema } from "effect";
import { expect } from "vitest";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { alice, bob, nativeTransactionJourney } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

const refusedHistoryChange = Effect.fn(function* (
  db: Effect.Success<typeof nativeTransactionJourney>,
  sql: string
) {
  expect(Exit.isFailure(yield* Effect.exit(native(() => db.exec(sql))))).toBe(true);
});

const initialContext = Effect.gen(function* () {
  const db = yield* nativeTransactionJourney;

  const observe = (binding?: string): Effect.Effect<Response> => {
    const headers = {
      origin: "https://app.fidyapp.com",
      cookie: "__Host-fidy_session=" + alice.bearer,
    };

    return native(() =>
      db.send(
        new Request("https://api.fidyapp.com/web/session/binding?context=application", {
          headers:
            binding === undefined ? headers : { ...headers, "Fidy-Session-Binding": binding },
        })
      )
    );
  };

  const head = (): Effect.Effect<Awaited<ReturnType<typeof db.exec>>> =>
    native(() =>
      db.exec(
        "SELECT idle_expires_at_ms,(SELECT count(*) FROM audit_entries) AS entries FROM web_sessions WHERE id=?",
        alice.session
      )
    );

  const original = yield* head();
  const missing = yield* observe();
  expect(missing.status).toBe(200);
  expect(yield* native(() => missing.json())).toEqual({
    binding: alice.session,
    initial: { status: "Missing", withdrawal: null },
  });
  expect((yield* observe(bob.session)).status).toBe(401);
  const time = yield* Clock.currentTimeMillis;

  const snapshot = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
    currentDisclosureFor()
  );

  yield* native(() =>
    db.exec(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',?,?)",
      alice.user,
      alice.user,
      time - 1,
      snapshot
    )
  );
  yield* native(() =>
    db.exec(
      "INSERT INTO consent_history(id,user_id,record_type,grant_record_id,session_id,occurred_at_ms) VALUES(?,?,'processing_withdrawal',?,?,?)",
      bob.user,
      alice.user,
      alice.user,
      alice.session,
      time
    )
  );

  yield* Effect.forEach(
    [
      "UPDATE consent_history SET session_id=NULL WHERE record_type='processing_withdrawal'",
      "DELETE FROM consent_history WHERE record_type='processing_withdrawal'",
    ],
    (sql) => refusedHistoryChange(db, sql),
    { discard: true }
  );

  const withdrawn = yield* observe();
  expect(withdrawn.status).toBe(200);
  expect(yield* native(() => withdrawn.json())).toEqual({
    binding: alice.session,
    initial: { status: "Revoked", withdrawal: { reference: bob.user, occurredAtMs: time } },
  });
  expect(yield* head()).toEqual(original);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "omits private metadata from the cookie-only initial application context after missing or withdrawn Consent without renewal or read evidence",
    () => initialContext
  );
});
