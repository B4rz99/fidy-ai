import { ErasureFrozenLedgerProgress } from "../../erasure/contract";
import { Effect, Option, Schema } from "effect";
import { ErasureGeneration, ErasureUnavailable } from "../../erasure-store/contract";
import { RecoveryAdmissionState, RecoverySourceTarget, RecoveryTarget } from "../contract";

const maximumCheckpointBytes = 64;
const maximumCheckpointEtagBytes = 128;
const SourceFence = Schema.Union([
  Schema.Struct({ state: Schema.Literal("Unplanned") }),
  Schema.Struct({
    state: Schema.Literal("Prepared"),
    from: ErasureGeneration,
    retired: Schema.String.check(Schema.isUUID()),
    registryCheckpoint: Schema.Struct({
      value: Schema.String.check(Schema.isMaxLength(maximumCheckpointBytes)),
      etag: Schema.String.check(Schema.isBetweenLength(1, maximumCheckpointEtagBytes)),
    }),
  }),
]);
export const ActivationRecord = Schema.Struct({
  activationId: Schema.String,
  admissionObjectId: RecoveryAdmissionState.fields.objectId,
  source: RecoverySourceTarget,
  serving: RecoveryTarget,
  cursor: Schema.String,
  sourceFence: SourceFence,
  sourceLedger: Schema.Union([
    Schema.Struct({ state: Schema.Literal("NotStarted") }),
    ErasureFrozenLedgerProgress,
  ]),
  phase: Schema.Literals([
    "AwaitingDrain",
    "ReconcilingAdmissions",
    "AwaitingOwnerDrain",
    "AwaitingProvider",
    "RetiringSource",
    "SourceRetired",
    "ObservingSourceLedger",
    "AwaitingFinalBarrier",
  ]),
  providerIsolation: Schema.Literal("Unqualified"),
});
export type ActivationRecord = typeof ActivationRecord.Type;
const key = "recovery/activation";
const maximumRecordBytes = 4096;
export const activationIo = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
export const sameTarget = ({
  left,
  right,
}: Readonly<{ left: RecoveryTarget; right: RecoveryTarget }>): boolean =>
  left.namespaceId === right.namespaceId &&
  left.objectId === right.objectId &&
  left.manifest === right.manifest &&
  left.epoch === right.epoch;
export const sameSource = ({
  left,
  right,
}: Readonly<{ left: RecoverySourceTarget; right: RecoverySourceTarget }>): boolean => {
  if (left.kind === "D1") {
    return (
      right.kind === "D1" && left.databaseId === right.databaseId && left.epoch === right.epoch
    );
  }
  return right.kind === "SQLite" && sameTarget({ left, right });
};
export const loadActivation = (
  bucket: R2Bucket
): Effect.Effect<
  Option.Option<Readonly<{ record: ActivationRecord; etag: string }>>,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    const object = yield* activationIo(() => bucket.get(key));
    if (object === null) return Option.none();
    if (object.size > maximumRecordBytes) return yield* new ErasureUnavailable();
    const record = yield* Schema.decodeEffect(Schema.fromJsonString(ActivationRecord), {
      onExcessProperty: "error",
    })(yield* activationIo(() => object.text()));
    return Option.some({ record, etag: object.etag });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
export const storeActivation = (
  input: Readonly<{
    bucket: R2Bucket;
    record: ActivationRecord;
    previous: Option.Option<Readonly<{ etag: string }>>;
  }>
): Effect.Effect<Response, ErasureUnavailable> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ActivationRecord))(
      input.record
    );
    const written = yield* activationIo(() =>
      input.bucket.put(key, encoded, {
        onlyIf: Option.isSome(input.previous)
          ? { etagMatches: input.previous.value.etag }
          : { etagDoesNotMatch: "*" },
      })
    );
    if (written === null) return yield* new ErasureUnavailable();
    return Response.json(input.record, { status: 202, headers: { "cache-control": "no-store" } });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
