import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import { alice, bob, nativeTransactionJourney } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

const day = 86400000;

const binding = "Fidy-Session-Binding";

const cookie = "__Host-fidy_session=" + alice.bearer;

const scenario = Effect.gen(function* () {
  const db = yield* nativeTransactionJourney;
  yield* native(() =>
    db.exec(
      "UPDATE users SET trial_started_at_ms=created_at_ms,trial_ends_at_ms=created_at_ms+604800000"
    )
  );
  yield* native(() =>
    db.exec(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES(?,?,'processing_grant',1)",
      alice.session,
      alice.user
    )
  );

  const send = (
    headers: Record<string, string>,
    path = "/user",
    method = "GET"
  ): Effect.Effect<Response> =>
    native(() =>
      db.send(
        new Request("https://api.fidyapp.com" + path, {
          method,
          headers: { origin: "https://app.fidyapp.com", ...headers },
        })
      )
    );

  const original = yield* native(() => db.exec("SELECT idle_expires_at_ms FROM web_sessions"));

  const refusals: Array<Record<string, string>> = [
    { cookie },
    { cookie, [binding]: "invalid" },
    { cookie, [binding]: bob.session },
    { cookie: cookie + "; " + cookie, [binding]: alice.session },
    { cookie: "__Host-fidy_session=" + bob.bearer, [binding]: alice.session },
    { cookie, [binding]: bob.session, authorization: "Bearer unrelated-credential" },
  ];

  yield* Effect.forEach(
    refusals,
    (headers) =>
      Effect.gen(function* () {
        const rejected = yield* send(headers);
        expect(rejected.status).toBe(401);
        expect(yield* native(() => rejected.text())).not.toContain(alice.user);
      }),
    { discard: true }
  );

  expect(yield* native(() => db.exec("SELECT idle_expires_at_ms FROM web_sessions"))).toEqual(
    original
  );
  expect(yield* native(() => db.exec("SELECT count(*) AS count FROM audit_entries"))).toEqual([
    { count: 0 },
  ]);
  const headers = { cookie, [binding]: alice.session };
  const response = yield* send(headers);
  expect(response.status).toBe(200);

  const profile = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      data: Schema.Struct({ id: Schema.String }),
      categories: Schema.Array(Schema.Unknown),
    })
  )(yield* native(() => response.json()));

  expect(profile.data.id).toBe(alice.user);
  const now = yield* Clock.currentTimeMillis;
  yield* native(() =>
    db.exec(
      "UPDATE web_sessions SET created_at_ms=?,fresh_until_ms=?,idle_expires_at_ms=?,hard_expires_at_ms=?",
      now - 89 * day,
      now - 89 * day + 600000,
      now + 60000,
      now + day
    )
  );
  expect((yield* send(headers)).status).toBe(200);
  expect(
    yield* native(() =>
      db.exec("SELECT idle_expires_at_ms=hard_expires_at_ms AS capped FROM web_sessions")
    )
  ).toEqual([{ capped: 1 }]);
  yield* native(() => db.exec("UPDATE web_sessions SET idle_expires_at_ms=?", now - 1));
  expect((yield* send(headers)).status).toBe(401);
  yield* native(() =>
    db.exec(
      "UPDATE web_sessions SET created_at_ms=?,fresh_until_ms=?,idle_expires_at_ms=?,hard_expires_at_ms=?",
      now - 91 * day,
      now - 91 * day + 600000,
      now - day,
      now - day
    )
  );
  expect((yield* send(headers)).status).toBe(401);
  yield* native(() =>
    db.exec(
      "UPDATE web_sessions SET created_at_ms=?,fresh_until_ms=?,idle_expires_at_ms=?,hard_expires_at_ms=?",
      now,
      now + 600000,
      now + day,
      now + 90 * day
    )
  );
  yield* native(() =>
    db.exec(
      "CREATE TRIGGER lost_revocation BEFORE UPDATE OF revoked_at_ms ON web_sessions BEGIN SELECT RAISE(IGNORE); END"
    )
  );
  expect((yield* send(headers, "/web/session/logout", "POST")).status).toBe(503);
  yield* native(() => db.exec("DROP TRIGGER lost_revocation"));
  expect((yield* send(headers, "/web/session/logout", "POST")).status).toBe(204);
  expect((yield* send(headers)).status).toBe(401);
  expect(
    yield* native(() =>
      db.exec("SELECT count(*) AS count FROM audit_entries WHERE record_type='identity_read'")
    )
  ).toEqual([{ count: 2 }]);
});

const revokedDuringRenewal = Effect.gen(function* () {
  const db = yield* nativeTransactionJourney;
  yield* native(() =>
    db.exec(
      "UPDATE users SET trial_started_at_ms=created_at_ms,trial_ends_at_ms=created_at_ms+604800000"
    )
  );
  yield* native(() =>
    db.exec(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES(?,?,'processing_grant',1)",
      alice.session,
      alice.user
    )
  );
  yield* native(() =>
    db.exec(
      "CREATE TRIGGER revoke_during_renewal AFTER UPDATE OF idle_expires_at_ms ON web_sessions BEGIN UPDATE web_sessions SET revoked_at_ms=1 WHERE id=NEW.id; END"
    )
  );
  const response = yield* native(() => db.browser(0, "/user"));
  expect(response.status).toBe(401);
  expect(yield* native(() => response.text())).not.toContain(alice.user);
  expect(
    yield* native(() => db.exec("SELECT id FROM audit_entries WHERE record_type='identity_read'"))
  ).toEqual([]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "refuses a session revoked during renewal before releasing its profile or read evidence",
    () => revokedDuringRenewal
  );
  test.effect(
    "requires the mounted binding for a User read and recognizes only the exact routed session",
    () => scenario
  );
});
