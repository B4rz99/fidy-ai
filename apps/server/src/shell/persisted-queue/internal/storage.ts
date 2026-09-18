import { Layer } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import {
  durableQueueLockExpiration,
  durableQueueLockRefreshInterval,
  durableQueuePollInterval,
  durableQueueTableName,
} from "~/shell/durable-queue-policy";

/** SQL queue substrate with the production table and lease policy. */
export const sqlStorage = PersistedQueue.layer.pipe(
  Layer.provide(
    PersistedQueue.layerStoreSql({
      tableName: durableQueueTableName,
      pollInterval: durableQueuePollInterval,
      lockExpiration: durableQueueLockExpiration,
      lockRefreshInterval: durableQueueLockRefreshInterval,
    })
  )
);

/** Process-local storage for tests that do not assert loss recovery. */
export const volatileStorage = PersistedQueue.layer.pipe(
  Layer.provide(PersistedQueue.layerStoreMemory)
);
