import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { browser } from "../browser-bootstrap.test-fixture";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";

const isolation = Effect.gen(function* () {
  const runtime = yield* (yield* nativeBrowserPlatform)();
  const { post, pair, verified } = browser(runtime);
  const independent = yield* verified("pairing-isolation-peer");
  expect((yield* post("/web/providers/google/complete", independent.proof)).status).toBe(200);

  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  const proof = yield* pair;

  const deadline = (): Effect.Effect<Awaited<ReturnType<typeof directory.exec>>> =>
    native(() =>
      directory.exec("SELECT expires_at_ms FROM browser_pairings WHERE id=?", proof.pairingId)
    );

  const original = yield* deadline();
  expect((yield* post("/web/pairings/redeem", proof)).status).toBe(202);
  const slow = yield* post("/web/pairings/redeem", proof);
  expect(slow.status).toBe(429);
  expect(Number(slow.headers.get("retry-after"))).toBeGreaterThan(0);

  yield* Effect.forEach(
    Array.from({ length: 5 }),
    () =>
      Effect.gen(function* () {
        const bad = yield* post("/web/pairings/redeem", {
          ...proof,
          privateVerifier: "r".repeat(43),
        });

        expect(bad.status).toBe(400);
        expect(bad.headers.get("retry-after")).toBe(null);
        expect(bad.headers.get("set-cookie")).toBe(null);
      }),
    { discard: true }
  );

  expect(
    yield* native(() =>
      directory.exec("SELECT wrong_attempts FROM browser_pairings WHERE id=?", proof.pairingId)
    )
  ).toEqual([{ wrong_attempts: 5 }]);
  expect(yield* deadline()).toEqual(original);
  expect((yield* post("/web/pairings/redeem", proof)).status).toBe(400);
  const redeemed = yield* post("/web/pairings/redeem", independent.proof);
  expect(redeemed.status).toBe(200);
  expect(redeemed.headers.get("set-cookie")).toContain("__Host-fidy_session");
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "retains the original Directory pairing deadline through slowdown and five invalid proofs while an independently approved pairing still redeems",
    () => isolation
  );
});
