import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "Subscription access",
  (it) => {
    it.effect("returns the configured Free-callable upgrade destination", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;

        const response = yield* client.subscription.getUpgradeUrl();

        expect(response.data.url).toEqual(new URL("https://fidyapp.com/upgrade"));
        expect(response.next).toEqual([]);
      })
    );
  }
);
