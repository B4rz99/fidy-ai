import { browser } from "../browser-bootstrap.test-fixture";
import { directoryName, externalLookupUrl, externalReserveUrl } from "../directory/contract";
import { maintenanceName, retireLifetimeUrl } from "../maintenance/contract";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import type { Miniflare } from "miniflare";
import { ErasureOperatorReceipt } from "../../src/core/erasure/contract";
import { alice, bob, history, receivedStatus, seed } from "../financial-user-store.test-fixture";
import { admitPurge, caseDriver } from "../erasure-purge.test-fixture";
import { native, nativeCustodyPlatform } from "../user-store.test-fixture";
import { erasureRegistryName } from "./contract";

const readWompiScope = Effect.fn(function* (runtime: Miniflare, reference: string) {
  const { FIXTURE_PROVIDER: signer } = yield* native(() =>
    runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
  );

  const token = yield* native(() =>
    signer.fetch("https://fixture.invalid/erasure-assertion").then((res) => res.text())
  );

  return yield* native(() =>
    runtime.dispatchFetch("https://api.fidyapp.com/internal/titular-erasure", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
      body: JSON.stringify({
        action: "CustodyScope",
        userId: alice.user,
        reference,
        custodian: "Wompi",
        after: 0,
      }),
    })
  );
});

const privateCaseAction = Effect.fnUntraced(function* (
  runtime: Miniflare,
  reference: string,
  action: "Receipt" | "Continue"
) {
  const { FIXTURE_PROVIDER: signer } = yield* native(() =>
    runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
  );

  const token = yield* native(() =>
    signer.fetch("https://fixture.invalid/erasure-assertion").then((res) => res.text())
  );

  return yield* native(() =>
    runtime.dispatchFetch("https://api.fidyapp.com/internal/titular-erasure", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
      body: JSON.stringify({ action, userId: alice.user, reference }),
    })
  );
});

const custodyJourney = Effect.fn(function* () {
  const runtime = yield* (yield* nativeCustodyPlatform)(undefined, [], {
    ERASURE_SUPPORT_AUDIENCE: "fixture-erasure",
  });

  const old = yield* seed(runtime, alice);
  yield* seed(runtime, bob);
  const mail = "22520000-0000-4000-8000-000000000022";
  yield* old.exec(
    "INSERT INTO browser_handoffs(id,pairing_id,user_id,ordinal,verifier_digest,expires_at_ms,wrong_attempts,minimum_poll_seconds,outcome,state,email_login) VALUES(?,?,?,100,'synthetic',?,0,1,'committed','pending_approval',1)",
    mail,
    mail,
    alice.user,
    old.now + 60000
  );
  yield* old.exec(
    "INSERT INTO login_email_proofs(pairing_id,work_id,address,revision,generation,requested_at_ms,expires_at_ms,offer_at_ms,state,selector) VALUES(?,?,'synthetic@example.test',1,1,?,?,?,'awaiting_proof','synthetic-selector')",
    mail,
    mail,
    old.now,
    old.now + 60000,
    old.now
  );
  const browserClient = browser(runtime);
  const testSubject = "test-custody-subject";
  yield* native(() =>
    old.directory.exec(
      "INSERT INTO provider_routes VALUES('https://accounts.google.com',?,?,?,1)",
      testSubject,
      alice.user,
      "original-reservation"
    )
  );

  const directory = (yield* native(() =>
    runtime.getDurableObjectNamespace("DIRECTORY", "core")
  )).getByName(directoryName);

  const oldRoute = {
    kind: "wompi",
    endpoint: "sandbox",
    lookup: "fidy-22520000-0000-4000-8000-000000000099",
    userId: alice.user,
    operationId: "22520000-0000-4000-8000-000000000099",
    family: "billing",
  };

  const reserve = (now = old.now): ReturnType<typeof history> =>
    native(() =>
      directory.fetch(externalReserveUrl, {
        method: "POST",
        headers: {
          "fidy-route-issued-ms": String(old.now),
          "fixture-erasure-clock": String(now),
        },
        body: JSON.stringify(oldRoute),
      })
    );

  expect((yield* reserve()).status).toBe(204);
  const driver = yield* caseDriver(runtime);
  const erased = yield* admitPurge(runtime);

  const { reference } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ reference: Schema.String })
  )(yield* native(() => erased.json()));

  yield* driver
    .step()
    .pipe(Effect.repeat({ until: (phase) => phase === "ExternalPending", times: 7 }));

  const owner = (yield* native(() =>
    runtime.getDurableObjectNamespace("ERASURE", "core")
  )).getByName(erasureRegistryName);

  const submit = Effect.fn(function* (path: string, data: Schema.JsonObject, instant?: number) {
    const now = instant ?? (yield* Clock.currentTimeMillis);

    return yield* native(() =>
      owner.fetch("https://coordinator.internal/erasure-" + path, {
        method: "POST",
        headers: { "fixture-erasure-clock": String(now) },
        body: JSON.stringify({
          userId: alice.user,
          reference,
          deadlineMs: now + 4000,
          authority: {
            permission: "titular.erase",
            operatorRef: "fixture-operator",
            expiresAtMs: now + 60000,
          },
          ...data,
        }),
      })
    );
  });

  const tick = Effect.fn(function* (instant: number) {
    yield* native(() => driver.storage.exec("UPDATE erasure_cases SET next_check_ms=1"));
    yield* native(() =>
      owner.fetch("https://fixture.invalid/case-alarm", {
        method: "POST",
        headers: { "fixture-erasure-clock": String(instant) },
      })
    );
  });

  const proof = Effect.fn(function* (
    custodian: string,
    outcome: readonly [string, number],
    now: number
  ) {
    const [status, suffix] = outcome;

    const value = {
      reference,
      custodian,
      outcome: { status },
      evidenceRef: "22520000-0000-4000-8000-" + String(suffix).padStart(12, "0"),
    };

    return (yield* submit("custody-evidence", { evidence: value }, now)).status;
  });

  const maintenance = (yield* native(() =>
    runtime.getDurableObjectNamespace("MAINTENANCE", "core")
  )).getByName(maintenanceName);

  const retire = (user: string): ReturnType<typeof history> =>
    native(() =>
      maintenance.fetch(retireLifetimeUrl, {
        method: "POST",
        headers: { "fidy-user-id": user, "fidy-erasure-reference": reference },
      })
    );

  return {
    runtime,
    old,
    driver,
    browserClient,
    testSubject,
    directory,
    oldRoute,
    reference,
    submit,
    tick,
    proof,
    retire,
    reserve,
  };
});

const verifyRelease = Effect.fn(function* (
  journey: Effect.Success<ReturnType<typeof custodyJourney>>,
  boundary: number
) {
  const {
    runtime,
    old,
    driver,
    browserClient,
    testSubject,
    oldRoute,
    submit,
    tick,
    retire,
    reserve,
    directory,
  } = journey;

  yield* native(() =>
    driver.storage.exec(
      "CREATE TRIGGER lose_release BEFORE UPDATE OF identity_released ON erasure_cases BEGIN SELECT RAISE(ABORT,'test lost release reply'); END"
    )
  );
  yield* tick(boundary);
  const fresh = yield* browserClient.verified(testSubject);
  expect((yield* browserClient.post("/web/providers/google/complete", fresh.proof)).status).toBe(
    200
  );

  const newRoute = yield* native(() =>
    old.directory.exec(
      "SELECT user_id FROM provider_routes WHERE issuer='https://accounts.google.com' AND subject=?",
      testSubject
    )
  );

  const newUser = yield* Schema.decodeUnknownEffect(Schema.String)(newRoute[0]?.user_id);
  expect(newUser).not.toBe(alice.user);
  yield* native(() => driver.storage.exec("DROP TRIGGER lose_release"));
  yield* tick(boundary);
  yield* native(() =>
    driver.storage.exec(
      "CREATE TRIGGER lose_retire BEFORE UPDATE OF lifetime_retired ON erasure_cases BEGIN SELECT RAISE(ABORT,'test lost retirement reply'); END"
    )
  );
  yield* tick(boundary);
  expect((yield* retire(newUser)).ok).toBe(false);
  expect((yield* retire(alice.user)).status).toBe(204);
  yield* native(() => driver.storage.exec("DROP TRIGGER lose_retire"));
  yield* tick(boundary);
  yield* tick(boundary);
  expect((yield* submit("receipt", {}, boundary)).status).toBe(200);
  const limit = old.now + 7776000000;
  yield* tick(limit - 1);
  expect((yield* submit("receipt", {}, limit - 1)).status).toBe(200);
  yield* tick(limit);
  expect((yield* submit("receipt", {}, limit)).status).toBe(409);
  expect((yield* retire(alice.user)).ok).toBe(false);
  expect((yield* reserve(limit)).ok).toBe(false);

  const callback = yield* native(() =>
    directory.fetch(externalLookupUrl, { method: "POST", body: JSON.stringify(oldRoute) })
  );

  expect(callback.status).toBe(404);
  expect((yield* browserClient.post("/web/pairings/redeem", fresh.proof)).status).toBe(200);
  expect(yield* receivedStatus(history(runtime, bob))).toBe(200);
  yield* native(() => runtime.unsafeEvictDurableObject("core", "UserStore", { name: alice.user }));
  expect(yield* receivedStatus(history(runtime, alice))).toBe(401);

  const users = (yield* native(() =>
    runtime.getDurableObjectNamespace("USER_STORE", "core")
  )).getByName(alice.user);

  const stale = yield* native(() =>
    users.fetch("https://user.invalid/bootstrap/complete", {
      method: "POST",
      body: JSON.stringify({
        id: "22520000-0000-4000-8000-000000000022",
        pairingId: "22520000-0000-4000-8000-000000000022",
        privateVerifier: "x".repeat(43),
      }),
    })
  );

  expect(stale.ok).toBe(false);
  expect(yield* old.exec("SELECT id FROM users")).toEqual([]);
});

const caseActionStatus = Effect.fn(function* (
  runtime: Miniflare,
  reference: string,
  [action, status]: readonly [Parameters<typeof privateCaseAction>[2], number]
) {
  expect((yield* privateCaseAction(runtime, reference, action)).status).toBe(status);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("an unresolved custodian remains pending beyond the platform recovery horizon", () =>
    Effect.gen(function* () {
      const { submit, reference, tick, runtime } = yield* custodyJourney();

      yield* Effect.forEach(
        [
          ["Receipt", 200],
          ["Continue", 202],
          ["Receipt", 200],
        ] as const,
        (expected) => caseActionStatus(runtime, reference, expected),
        { discard: true }
      );

      const unresolved = {
        reference,
        custodian: "Resend",
        evidenceRef: "22520000-0000-4000-8000-000000000023",
        outcome: { status: "Unresolved", reason: "retention-conflict" },
      };

      expect((yield* submit("custody-evidence", { evidence: unresolved })).status).toBe(202);
      const later = (yield* Clock.currentTimeMillis) + 2_592_000_001;
      yield* tick(later);
      const pending = yield* submit("receipt", {}, later);

      const receipt = yield* Schema.decodeUnknownEffect(ErasureOperatorReceipt)(
        yield* native(() => pending.json())
      );

      expect(receipt.state).toBe("ExternalPending");
      expect(receipt.custodians).toContainEqual({
        custodian: "Resend",
        status: "Unresolved",
        reason: "retention-conflict",
      });
    })
  );
  test.effect("requires a dedicated erasure audience for custody scope at public ingress", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* nativeCustodyPlatform)(undefined, [], {
        ERASURE_SUPPORT_AUDIENCE: "fixture-erasure",
        SAMPLE_REVIEW_AUDIENCE: "fixture-erasure",
      });

      const response = yield* readWompiScope(runtime, "22520000-0000-4000-8000-000000000001");
      expect(response.status).toBe(401);
    })
  );
  test.effect("the independent operator records exact custody after the User store is gone", () =>
    Effect.gen(function* () {
      const journey = yield* custodyJourney();
      const { old, browserClient, testSubject, oldRoute, reference, submit, tick, proof } = journey;
      const denied = yield* submit("receipt", { userId: bob.user });
      expect(denied.status).toBe(409);
      expect(
        (yield* submit("custody-scope", { custodian: "Wompi", after: 0, deadlineMs: 1 })).status
      ).toBe(409);

      const evidence = {
        reference,
        custodian: "Kapso",
        evidenceRef: "22520000-0000-4000-8000-000000000001",
        outcome: { status: "Accepted" },
      };

      expect((yield* submit("custody-evidence", { evidence })).status).toBe(202);
      expect((yield* submit("custody-evidence", { evidence })).status).toBe(202);
      expect(
        (yield* submit("custody-evidence", {
          evidence: { ...evidence, outcome: { status: "Verified" } },
        })).status
      ).toBe(409);
      const receipt = yield* submit("receipt", {});

      const current = yield* Schema.decodeUnknownEffect(ErasureOperatorReceipt)(
        yield* native(() => receipt.json())
      );

      expect(current.custodians).toContainEqual({ custodian: "Kapso", status: "Accepted" });
      expect(current.state).toBe("ExternalPending");
      const firstSignup = yield* browserClient.verified(testSubject);
      expect(
        (yield* browserClient.post("/web/providers/google/complete", firstSignup.proof)).ok
      ).toBe(false);
      const selector = yield* readWompiScope(journey.runtime, journey.reference);
      expect(selector.status).toBe(200);
      expect(yield* native(() => selector.json())).toEqual({
        entries: [{ endpoint: "sandbox", lookup: oldRoute.lookup }],
        next: null,
      });
      const before = yield* Clock.currentTimeMillis;
      expect(yield* proof("Cloudflare", ["NotApplicable", 2], before)).toBe(409);
      expect(yield* proof("Kapso", ["Verified", 3], before)).toBe(202);
      expect(yield* proof("Meta", ["NotApplicable", 4], before)).toBe(202);
      expect(yield* proof("Resend", ["NotApplicable", 5], before)).toBe(409);
      const scope = yield* submit("custody-scope", { custodian: "Resend", after: 0 });
      expect(yield* native(() => scope.json())).toEqual({
        entries: [{ workId: "22520000-0000-4000-8000-000000000022", requestedAtMs: old.now }],
        next: null,
      });
      expect(yield* proof("Resend", ["Verified", 6], before)).toBe(202);
      expect(yield* proof("Wompi", ["Verified", 7], before)).toBe(202);
      expect((yield* submit("custody-scope", { custodian: "Wompi", after: 0 })).ok).toBe(false);

      yield* tick(before).pipe(Effect.repeat({ times: 7 }));
      const updated = yield* submit("receipt", {}, before);

      const cleaned = yield* Schema.decodeUnknownEffect(ErasureOperatorReceipt)(
        yield* native(() => updated.json())
      );

      expect(cleaned.completed).toContain("billing");
      expect(cleaned.completed).not.toContain("identity");
      expect(cleaned.recoveryUntilMs).toBeGreaterThan(current.recoveryUntilMs ?? 0);
      const boundary = cleaned.recoveryUntilMs ?? 0;
      expect(yield* proof("Cloudflare", ["Verified", 8], boundary - 1)).toBe(409);
      yield* tick(boundary);
      expect(yield* proof("Cloudflare", ["Verified", 8], boundary)).toBe(202);
      yield* tick(boundary);
      const complete = yield* submit("receipt", {}, boundary);
      expect(yield* native(() => complete.json())).toMatchObject({
        state: "Complete",
        next: "none",
      });

      yield* verifyRelease(journey, boundary);
    })
  );
});
