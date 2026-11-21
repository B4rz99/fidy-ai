import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import { signedWebhook } from "../browser-bootstrap.test-fixture";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";
import { alice, bob, seed } from "../financial-user-store.test-fixture";

const prior = "CO.573001234567",
  next = "CO.573009876543";

const scenario = Effect.gen(function* () {
  const runtime = yield* (yield* nativeBrowserPlatform)();
  const owner = yield* seed(runtime, alice, false);
  const other = yield* seed(runtime, bob, false);
  const now = yield* Clock.currentTimeMillis;
  yield* owner.exec(
    "UPDATE users SET whatsapp_portfolio_id='portfolio',whatsapp_bsuid=?,whatsapp_verified_at_ms=?",
    prior,
    now - 60000
  );
  yield* other.exec(
    "UPDATE users SET whatsapp_portfolio_id='portfolio',whatsapp_bsuid=?,whatsapp_verified_at_ms=?",
    next,
    now - 60000
  );
  yield* native(() =>
    owner.directory.exec(
      "INSERT INTO whatsapp_routes(portfolio,bsuid,user_id,attempt_id,established) VALUES('portfolio',?,?,?,1),('portfolio',?,?,?,1)",
      prior,
      alice.user,
      "first",
      next,
      bob.user,
      "other"
    )
  );

  const payload = new TextEncoder().encode(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                messages: [
                  {
                    id: "wamid.replace-test",
                    timestamp: String(Math.floor(now / 1000)),
                    type: "system",
                    system: {
                      body: "User Ada changed from " + prior + " to " + next,
                      type: "user_changed_user_id",
                      user_id: next,
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    })
  );

  const post = (secret = "test-kapso-secret"): ReturnType<typeof signedWebhook> =>
    signedWebhook(runtime, payload, secret);

  expect((yield* post("invalid-webhook-secret")).status).toBe(401);
  expect((yield* post()).status).toBe(409);
  expect(yield* owner.exec("SELECT whatsapp_bsuid FROM users")).toEqual([
    { whatsapp_bsuid: prior },
  ]);
  yield* native(() =>
    owner.directory.exec("DELETE FROM whatsapp_routes WHERE user_id=?", bob.user)
  );
  yield* owner.exec(
    "CREATE TRIGGER lose_switch BEFORE INSERT ON identity_change_outcomes BEGIN SELECT RAISE(IGNORE); END"
  );
  expect((yield* post()).status).toBe(503);
  expect(yield* owner.exec("SELECT whatsapp_bsuid FROM users")).toEqual([
    { whatsapp_bsuid: prior },
  ]);
  expect(
    yield* native(() =>
      owner.directory.exec(
        "SELECT bsuid FROM whatsapp_routes WHERE user_id=? ORDER BY bsuid",
        alice.user
      )
    )
  ).toHaveLength(2);
  yield* owner.exec("DROP TRIGGER lose_switch");
  yield* native(() =>
    owner.directory.exec(
      "CREATE TRIGGER lose_ack BEFORE DELETE ON whatsapp_routes BEGIN SELECT RAISE(IGNORE); END"
    )
  );
  expect((yield* post()).status).toBe(503);
  expect(yield* owner.exec("SELECT whatsapp_bsuid FROM users")).toEqual([{ whatsapp_bsuid: next }]);
  yield* native(() => owner.directory.exec("DROP TRIGGER lose_ack"));
  yield* native(() =>
    owner.directory.exec(
      "UPDATE whatsapp_routes SET attempt_id='later-owner',user_id=? WHERE bsuid=?",
      bob.user,
      prior
    )
  );
  expect((yield* post()).status).toBe(200);
  expect((yield* post()).status).toBe(200);
  expect(
    yield* native(() =>
      owner.directory.exec("SELECT user_id,attempt_id FROM whatsapp_routes WHERE bsuid=?", prior)
    )
  ).toEqual([{ user_id: bob.user, attempt_id: "later-owner" }]);
  expect(yield* owner.exec("SELECT whatsapp_bsuid FROM users")).toEqual([{ whatsapp_bsuid: next }]);
  expect(
    yield* native(() =>
      owner.directory.exec("SELECT bsuid FROM whatsapp_routes WHERE user_id=?", alice.user)
    )
  ).toEqual([{ bsuid: next }]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "applies one authenticated BSUID transition after reserving its globally unique replacement",
    () => scenario
  );
});
