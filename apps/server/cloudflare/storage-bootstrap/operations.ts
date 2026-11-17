import { Effect, Schema } from "effect";
import { directoryName } from "../directory/contract";
import { pricingName } from "../subscription/contract";
import { erasureRegistryName } from "../erasure/contract";
import { releaseProbeName, storeReadinessUrl } from "../runtime/sqlite/contract";
import { type SharedBindings, SharedStoreMarkers } from "./contract";

/** Fixed private objects only. Native construction performs each owner's transaction and seed. */
export const initializeSharedStores = Effect.fn(function* (bindings: SharedBindings) {
  const read = Effect.fn(function* (binding: SharedBindings[keyof SharedBindings], name: string) {
    if (binding === undefined) return yield* Effect.fail(Error("Missing shared store"));
    const response = yield* Effect.tryPromise((signal) =>
      binding.getByName(name).fetch(storeReadinessUrl, { signal })
    );
    if (!response.ok) return yield* Effect.fail(Error("Shared store unavailable"));
    return yield* Effect.tryPromise(() => response.json());
  });
  const markers = yield* Effect.all(
    {
      user: read(bindings.USER_STORE, releaseProbeName),
      directory: read(bindings.DIRECTORY, directoryName),
      pricing: read(bindings.PRICING, pricingName),
      maintenance: read(bindings.MAINTENANCE, "core-maintenance-v1"),
      erasure: read(bindings.ERASURE, erasureRegistryName),
    },
    { concurrency: 4 }
  );
  return yield* Schema.decodeUnknownEffect(SharedStoreMarkers)(markers);
});
