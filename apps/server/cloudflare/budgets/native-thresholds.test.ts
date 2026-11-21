import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, DateTime, Effect, Schema } from "effect";
import { expect } from "vitest";
import {
  alice,
  bob,
  category,
  nativeBrowserWrite,
  nativeTransactionJourney,
} from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { webSignupDisclosure } from "../../src/shell/consent/operations";

const crossed = Effect.gen(function* () {
  const db = yield* nativeTransactionJourney,
    write = nativeBrowserWrite(db),
    now = yield* Clock.currentTimeMillis;

  const disclosure = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
    webSignupDisclosure()
  );

  yield* native(() =>
    db.exec(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',?,?)",
      alice.session,
      alice.user,
      now - 1000,
      disclosure
    )
  );
  const cap = { categoryId: category, cap: { amount: "9007199254740993.15", currency: "COP" } };
  expect((yield* write(alice, { path: "/budgets", method: "POST", body: cap })).status).toBe(201);

  const create = Effect.fn(function* (amount: string, currency: string) {
    return yield* write(alice, {
      path: "/transactions",
      method: "POST",
      body: {
        money: { amount, currency },
        categoryId: category,
        direction: "outflow",
        occurredAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      },
    });
  });

  expect((yield* create("10000000000000000", "USD")).status).toBe(201);
  expect(yield* native(() => db.exec("SELECT threshold FROM budget_threshold_crossings"))).toEqual(
    []
  );
  const captured = yield* create(cap.cap.amount, "COP");
  expect(captured.status).toBe(201);

  const { data } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
  )(yield* native(() => captured.json()));

  expect(
    (yield* write(alice, {
      path: "/transactions/" + data.id,
      method: "PUT",
      body: { expectedRevision: 0, changes: { money: { amount: "1", currency: "COP" } } },
    })).status
  ).toBe(200);

  const frozen =
    "SELECT threshold,json_extract(crossing_json,'$.cap.amount') AS cap,json_extract(crossing_json,'$.spent.amount') AS spent,grant_id FROM budget_threshold_crossings ORDER BY threshold";

  const expected = [80, 100].map((threshold) => ({
    threshold,
    cap: cap.cap.amount,
    spent: cap.cap.amount,
    grant_id: null,
  }));

  expect(yield* native(() => db.exec(frozen))).toEqual(expected);
  expect((yield* create(cap.cap.amount, "COP")).status).toBe(201);
  expect(yield* native(() => db.exec(frozen))).toEqual(expected);
  expect(yield* native(() => db.owner(bob.user).exec(frozen))).toEqual([]);
  expect(yield* native(() => db.exec("SELECT count(*) n FROM reminder_deliveries"))).toEqual([
    { n: 0 },
  ]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "freezes both exact monthly thresholds before a correction without delivering a pre-opt-in crossing",
    () => crossed
  );
});
