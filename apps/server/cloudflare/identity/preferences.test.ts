import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { expect } from "vitest";
import {
  alice,
  bob,
  nativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

const scenario = Effect.gen(function* () {
  const db = yield* nativeTransactionJourney;
  yield* native(() =>
    db.exec(
      "UPDATE users SET trial_started_at_ms=created_at_ms,trial_ends_at_ms=created_at_ms+604800000"
    )
  );
  yield* native(() =>
    db.exec(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES (? ,?,'processing_grant',1)",
      alice.session,
      alice.user
    )
  );

  const send = (path: string, method: string, body: unknown): Effect.Effect<Response> =>
    native(() =>
      db.send(
        new Request("https://api.fidyapp.com" + path, {
          method,
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: "__Host-fidy_session=" + alice.bearer,
            "Fidy-Session-Binding": alice.session,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      )
    );

  const token = "fin_abcdefgh_" + "x".repeat(43);
  yield* seedNativePAT({
    db,
    userId: alice.user,
    token,
    scopes: ["read"],
    current: yield* Clock.currentTimeMillis,
  });

  const profile = yield* native(() =>
    db.send(
      new Request("https://api.fidyapp.com/user", {
        headers: { authorization: "Bearer " + token },
      })
    )
  );

  expect(profile.status).toBe(200);
  expect(yield* native(() => profile.json())).toMatchObject({
    data: { id: alice.user, timeZone: "America/Bogota" },
  });
  const preferences = { locale: "es-CO", timeZone: "Europe/Madrid" };
  const first = yield* send("/user/preferences", "PATCH", preferences);
  expect(first.status).toBe(200);
  expect(yield* native(() => first.json())).toMatchObject({
    data: { id: alice.user, ...preferences },
  });

  const call = {
    callId: alice.session,
    operation: "identity.updateUserPreferences",
    input: { payload: { ...preferences, timeZone: "America/Lima" } },
  };

  const rollback = yield* send("/operations/atomic-batch", "POST", {
    calls: [
      call,
      {
        callId: bob.session,
        operation: "categories.deleteKeywordRule",
        input: { params: { id: bob.user } },
      },
    ],
  });

  expect(rollback.status).toBe(400);
  const own = yield* native(() => db.browser(0, "/user"));
  expect(yield* native(() => own.json())).toMatchObject({ data: preferences });
  const success = yield* send("/operations/atomic-batch", "POST", { calls: [call] });
  expect(success.status).toBe(200);
  expect(yield* native(() => success.json())).toMatchObject({
    data: { results: [{ output: { data: { id: alice.user, timeZone: "America/Lima" } } }] },
  });
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "updates preferences through the same owner individually and in an atomic batch",
    () => scenario
  );
});
