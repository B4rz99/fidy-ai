import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { admitPurge, caseDriver } from "../erasure-purge.test-fixture";
import { alice, seed } from "../financial-user-store.test-fixture";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";
import { expect } from "vitest";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "seals erasure after a support-confirmed no-charge decision on an ambiguous sent attempt",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBillingPlatform)();
        const first = yield* seed(runtime, alice);
        const driver = yield* caseDriver(runtime);
        const registry = driver.storage;
        yield* first.exec(
          "INSERT INTO subscriptions(id,user_id) VALUES('sub-ambiguous','" + alice.user + "')"
        );
        yield* first.exec(
          "INSERT INTO payment_sources(id,subscription_id) VALUES('src-ambiguous','sub-ambiguous')"
        );
        yield* first.exec(
          "INSERT INTO billing_attempts(id,subscription_id,payment_source_id,collection_state,status) VALUES('att-ambiguous','sub-ambiguous','src-ambiguous','sent','pending')"
        );
        expect((yield* admitPurge(runtime)).status).toBe(202);
        expect(yield* driver.step()).toBe("Draining");
        expect(
          (yield* native(() => registry.exec("SELECT state FROM erasure_cases")))[0]?.state
        ).toBe("Draining");
        yield* first.exec(
          "UPDATE billing_attempts SET no_charge_confirmed_at_ms=1 WHERE id='att-ambiguous'"
        );
        expect(yield* driver.step()).toBe("Sealing");
        expect(yield* first.exec("SELECT state FROM erasure_requests")).toEqual([
          { state: "Sealing" },
        ]);
      })
  );
  test.effect("refuses sealing while an ambiguous sent attempt stays pending", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* nativeBillingPlatform)();
      const first = yield* seed(runtime, alice);
      const driver = yield* caseDriver(runtime);
      yield* first.exec(
        "INSERT INTO subscriptions(id,user_id) VALUES('sub-ambiguous','" + alice.user + "')"
      );
      yield* first.exec(
        "INSERT INTO payment_sources(id,subscription_id) VALUES('src-ambiguous','sub-ambiguous')"
      );
      yield* first.exec(
        "INSERT INTO billing_attempts(id,subscription_id,payment_source_id,collection_state,status) VALUES('att-ambiguous','sub-ambiguous','src-ambiguous','sent','pending')"
      );
      expect((yield* admitPurge(runtime)).status).toBe(202);
      expect(yield* driver.step()).toBe("Draining");
      expect(yield* driver.step()).toBe("Draining");
      expect(yield* first.exec("SELECT state FROM erasure_requests")).toEqual([
        { state: "Draining" },
      ]);
    })
  );
});
