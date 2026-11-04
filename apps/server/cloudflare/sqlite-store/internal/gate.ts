import { Option, Schema } from "effect";
import {
  type SqliteStoreEnvironment,
  type SqliteStoreObservation,
  SqliteStoreRequest,
} from "../contract";

const Seal = Schema.Struct({
  manifest: SqliteStoreRequest.fields.manifest,
  epoch: SqliteStoreRequest.fields.epoch,
  status: Schema.Literal("verified"),
});
export const StoreAdmission = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("Open"), epoch: SqliteStoreRequest.fields.epoch }),
  Schema.Struct({
    phase: Schema.Literal("Closed"),
    activationId: SqliteStoreRequest.fields.manifest,
    epoch: SqliteStoreRequest.fields.epoch,
  }),
]);
export type NativeStore = Readonly<{
  storage: DurableObjectStorage;
  environment: SqliteStoreEnvironment;
  objectId: string;
}>;
/** A restored seal cannot itself authorize activation; the independent release barrier remains unqualified. */
export const storeObservation = (store: NativeStore): Option.Option<SqliteStoreObservation> => {
  const seal = Schema.decodeUnknownOption(Seal)(store.storage.kv.get("store-seal"));
  if (
    Option.isNone(seal) ||
    seal.value.manifest !== store.environment.SQLITE_STORE_MANIFEST ||
    seal.value.epoch !== store.environment.SQLITE_STORE_EPOCH ||
    store.environment.SQLITE_STORE_NAMESPACE_ID === undefined
  ) {
    return Option.none();
  }
  const admission = Schema.decodeUnknownOption(StoreAdmission)(
    store.storage.kv.get("store-admission")
  );
  if (Option.isNone(admission) || admission.value.epoch !== seal.value.epoch) return Option.none();
  return Option.some({
    target: {
      namespaceId: store.environment.SQLITE_STORE_NAMESPACE_ID,
      objectId: store.objectId,
      manifest: seal.value.manifest,
      epoch: seal.value.epoch,
    },
    admission: admission.value.phase,
    activationId: admission.value.phase === "Closed" ? admission.value.activationId : "",
    queryLeases: 0,
    releaseBarrier: "Unqualified",
  });
};
