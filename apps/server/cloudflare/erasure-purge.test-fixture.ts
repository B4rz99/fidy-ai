import type { Miniflare } from "miniflare";
import { Effect } from "effect";
import { alice } from "./financial-user-store.test-fixture";
import { native } from "./user-store.test-fixture";
import { erasureRegistryName } from "./erasure/contract";
import { ownerCheckUrl } from "./maintenance/contract";
import { browserOrigins, productionTopology } from "./runtime/contract";

export const admitPurge = Effect.fn(function* (runtime: Miniflare) {
  return yield* native(() =>
    runtime.dispatchFetch(
      "https://" + productionTopology.ingress.hostname + "/web/privacy/erasure",
      {
        method: "POST",
        headers: {
          origin: browserOrigins.production,
          "content-type": "application/json",
          "Fidy-Session-Binding": alice.session,
          cookie: "__Host-fidy_session=" + alice.bearer,
        },
        body: '{"confirm":true}',
      }
    )
  );
});

export const caseDriver = Effect.fn(function* (runtime: Miniflare) {
  const storage = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Erasure", { name: erasureRegistryName })
  );

  const cases = (yield* native(() =>
    runtime.getDurableObjectNamespace("ERASURE", "core")
  )).getByName(erasureRegistryName);

  const step = Effect.fn(function* () {
    yield* native(() =>
      storage.exec("UPDATE erasure_cases SET next_check_ms=1 WHERE state<>'ExternalPending'")
    );
    yield* native(() => cases.fetch(ownerCheckUrl, { method: "POST" }));
    yield* Effect.sleep("120 millis");

    return (yield* native(() => storage.exec("SELECT state FROM erasure_cases")))[0]?.state;
  });

  return { storage, step };
});
