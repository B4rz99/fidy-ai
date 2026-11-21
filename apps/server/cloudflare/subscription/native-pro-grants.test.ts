import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { expect } from "vitest";
import { newId } from "../secret-material/operations";
import { betaUserUrl } from "../beta-pro/contract";
import { activeProUserCondition } from "../../src/shell/access-tier/operations";
import { alice, bob, nativeTransactionJourney } from "../financial-user-store.test-fixture";
import { admitPurge } from "../erasure-purge.test-fixture";
import { native } from "../user-store.test-fixture";

const nativeStanding = Effect.gen(function* () {
  const owner = yield* nativeTransactionJourney;
  const now = yield* Clock.currentTimeMillis;

  const exec = (
    ...args: Parameters<typeof owner.exec>
  ): Effect.Effect<Awaited<ReturnType<typeof owner.exec>>> => native(() => owner.exec(...args));

  const users = yield* native(() => owner.runtime.getDurableObjectNamespace("USER_STORE", "core"));

  const record = (
    action: "grant" | "revoke",
    userId = alice.user
  ): Effect.Effect<ReadonlyArray<unknown>> =>
    native(() =>
      users
        .getByName(alice.user)
        .fetch(betaUserUrl, {
          method: "POST",
          body: JSON.stringify({
            command: { action, userId, requestId: newId() },
            authority: {
              issuer: "https://fixture.cloudflareaccess.com",
              subject: "synthetic-actor",
              email: "synthetic-beta-operator",
              deadline: now + 60000,
            },
          }),
        })
        .then((response) => (response.ok ? response.json().then((value) => [value]) : []))
    );

  const standing = (index = 0): Effect.Effect<unknown> =>
    native(() => owner.browser(index, "/subscription/status").then((response) => response.json()));

  const paid = (): ReturnType<typeof exec> => {
    const selection = activeProUserCondition({ userId: alice.user, nowEpochMs: now });

    return exec("SELECT " + selection.sql + " AS pro", ...selection.params);
  };

  const account = (): ReturnType<typeof exec> =>
    exec(
      "SELECT (SELECT count(*) FROM subscriptions) AS subscriptions,(SELECT count(*) FROM billing_attempts) AS attempts"
    );

  const off = (): ReturnType<typeof exec> =>
    exec("UPDATE users SET trial_started_at_ms=?,trial_ends_at_ms=?", now - 604800001, now - 1);

  yield* off();

  const peer = yield* native(() =>
    owner.runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: bob.user })
  );

  yield* native(() =>
    peer.exec("UPDATE users SET trial_started_at_ms=?,trial_ends_at_ms=?", now - 604800001, now - 1)
  );
  const original = yield* account();
  expect(yield* record("grant", bob.user)).toEqual([]);
  expect(yield* record("grant")).toEqual([{ userId: alice.user, action: "grant" }]);
  expect(yield* standing()).toMatchObject({
    data: { accessTier: "pro", hasProGrant: true, paidSubscription: null },
  });
  expect(yield* standing(1)).toMatchObject({
    data: { accessTier: "free", hasProGrant: false, paidSubscription: null },
  });
  expect(yield* record("revoke")).toHaveLength(1);
  expect(yield* standing()).toMatchObject({ data: { accessTier: "free", hasProGrant: false } });
  yield* exec(
    "UPDATE users SET trial_started_at_ms=?,trial_ends_at_ms=?",
    now - 1,
    now + 604799999
  );
  yield* record("grant");
  yield* record("revoke");
  expect(yield* standing()).toMatchObject({
    data: { accessTier: "pro", hasProGrant: false, paidSubscription: null },
  });
  expect(yield* account()).toEqual(original);
  yield* off();
  yield* exec("INSERT INTO subscriptions(id,user_id) VALUES ('subscription',?)", alice.user);
  yield* exec(
    "INSERT INTO payment_sources(id,subscription_id,method,wompi_environment,wompi_source_id) VALUES ('source','subscription','card','sandbox',78001)"
  );
  yield* exec(
    "INSERT INTO billing_attempts(id,subscription_id,payment_source_id,paid_starts_at_ms,paid_ends_at_ms,wompi_environment) VALUES ('settled','subscription','source',?,?,'sandbox')",
    now - 1000,
    now + 3600000
  );
  yield* exec("UPDATE subscriptions SET current_paid_attempt_id='settled' WHERE id='subscription'");
  const billing = yield* account();
  yield* record("grant");
  yield* record("revoke");
  expect(yield* paid()).toEqual([{ pro: 1 }]);
  expect(yield* account()).toEqual(billing);

  const changed = yield* native(() =>
    owner.exec("UPDATE pro_grant_events SET operator='different-actor' WHERE sequence=1").then(
      () => true,
      () => false
    )
  );

  expect(changed).toBe(false);
  expect(yield* exec("SELECT action,operator FROM pro_grant_events ORDER BY sequence")).toEqual(
    ["grant", "revoke", "grant", "revoke", "grant", "revoke"].map((action) => ({
      action,
      operator: "synthetic-beta-operator",
    }))
  );
  expect((yield* admitPurge(owner.runtime)).status).toBe(202);
  expect(yield* exec("SELECT id FROM users")).toEqual([{ id: alice.user }]);
  expect(yield* record("grant")).toEqual([]);
  expect(yield* record("revoke")).toEqual([]);
  expect(yield* exec("SELECT count(*) AS total FROM pro_grant_events")).toEqual([{ total: 6 }]);
  expect((yield* native(() => owner.browser(0, "/subscription/status"))).status).toBe(401);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "uses ordered ManualProGrant events only for the selected live User and preserves independent Trial, paid terms and billing on revocation",
    () => nativeStanding
  );
});
