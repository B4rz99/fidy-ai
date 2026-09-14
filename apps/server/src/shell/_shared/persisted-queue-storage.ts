import { Layer } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import {
  durableQueueLockExpiration,
  durableQueueLockRefreshInterval,
  durableQueuePollInterval,
  durableQueueTableName,
} from "~/shell/durable-queue-policy";

/** Shared SQL queue substrate using the explicit production table and lock policy. */
export const SqlPersistedQueueLive = PersistedQueue.layer.pipe(
  Layer.provideMerge(
    PersistedQueue.layerStoreSql({
      tableName: durableQueueTableName,
      pollInterval: durableQueuePollInterval,
      lockExpiration: durableQueueLockExpiration,
      lockRefreshInterval: durableQueueLockRefreshInterval,
    })
  )
);

/** Volatile queue substrate for tests that do not assert process-loss behavior. */
export const PersistedQueueMemory = PersistedQueue.layer.pipe(
  Layer.provideMerge(PersistedQueue.layerStoreMemory)
);
