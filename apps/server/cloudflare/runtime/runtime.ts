import { Effect, Option } from "effect";
import {
  type PlatformMaintenance,
  type PlatformMaintenanceInput,
  PlatformMaintenanceUnavailable,
} from "./contract";
import { inspectScheduledHealth } from "./internal/scheduled-health";
import { sendCanary } from "./operational-health/operations";
/** Construct independent platform activities with fixed operational policies and closed failures. */
export const makePlatformMaintenance = (input: PlatformMaintenanceInput): PlatformMaintenance => ({
  inspectHealth: () =>
    inspectScheduledHealth(input).pipe(Effect.mapError(() => new PlatformMaintenanceUnavailable())),
  publishCanary: (nowEpochMs) => {
    if (!Option.contains(input.ASYNC_HEALTH_ENABLED, "enabled")) return Effect.void;
    const queue = input.OPERATIONAL_CANARY_QUEUE;
    return Option.isNone(queue)
      ? Effect.fail(new PlatformMaintenanceUnavailable())
      : Effect.tryPromise({
          try: (signal) => sendCanary({ queue: queue.value, now: nowEpochMs, signal }),
          catch: () => new PlatformMaintenanceUnavailable(),
        });
  },
});
