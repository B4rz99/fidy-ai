import { Effect, Schema } from "effect";
import { ErasureUnavailable } from "../../erasure-store/contract";
import {
  prepareErasureSourceFreeze,
  readErasureSourceGeneration,
  retireErasureSource,
} from "../../erasure/operations";
import { newId } from "../../secret-material/operations";
import type { RecoveryActivationEnvironment, RecoveryAdmissionState } from "../contract";
import { type ActivationRecord, activationIo } from "./record";

const maximumRegistryBytes = 64;
const pendingPrefix = "publishing:";
const RawCheckpoint = Schema.Struct({ value: Schema.String, etag: Schema.String });
const registryCheckpoint = (
  bucket: R2Bucket
): Effect.Effect<typeof RawCheckpoint.Type, ErasureUnavailable> =>
  Effect.gen(function* () {
    const object = yield* activationIo(() => bucket.get("recovery/generation"));
    if (object === null) return yield* new ErasureUnavailable();
    if (object.size > maximumRegistryBytes) {
      yield* activationIo(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    const value = yield* activationIo(() => object.text());
    if (value !== "initial") {
      yield* Schema.decodeEffect(Schema.String.check(Schema.isUUID()))(
        value.startsWith(pendingPrefix) ? value.slice(pendingPrefix.length) : value
      );
    }
    return { value, etag: object.etag };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
type RetirementInput = Readonly<{
  record: ActivationRecord;
  configuration: RecoveryActivationEnvironment;
  bucket: R2Bucket;
  state: RecoveryAdmissionState;
}>;
const requireClosed = (input: RetirementInput): Effect.Effect<void, ErasureUnavailable> => {
  const { record, state } = input;
  return record.source.kind === "D1" &&
    state.closed &&
    state.paused &&
    state.leases === 0 &&
    state.objectId === record.admissionObjectId &&
    state.epoch === record.source.epoch &&
    state.activationId === record.activationId
    ? Effect.void
    : Effect.fail(new ErasureUnavailable());
};
/** Persist this plan before any source SQL mutation. It is a fence, never a provider drain receipt. */
export const planSourceRetirement = (
  input: RetirementInput
): Effect.Effect<ActivationRecord, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* requireClosed(input);
    if (input.record.sourceFence.state !== "Unplanned") return yield* new ErasureUnavailable();
    const from = yield* readErasureSourceGeneration({ db: input.configuration.sourceDb });
    const registry = yield* registryCheckpoint(input.bucket);
    const retired = yield* Effect.sync(newId);
    if (retired === from || retired === registry.value) return yield* new ErasureUnavailable();
    const freeze = yield* prepareErasureSourceFreeze({
      db: input.configuration.sourceDb,
      generation: retired,
    });
    return {
      ...input.record,
      phase: "RetiringSource" as const,
      sourceFence: {
        state: "Prepared" as const,
        from,
        retired,
        freeze,
        registryCheckpoint: registry,
      },
    };
  });
/** An interrupted native commit resumes from the same durable retired marker, never from serving NEW. */
export const resumeSourceRetirement = (
  input: RetirementInput
): Effect.Effect<ActivationRecord, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* requireClosed(input);
    const fence = input.record.sourceFence;
    if (fence.state !== "Prepared") return yield* new ErasureUnavailable();
    yield* registryCheckpoint(input.bucket);
    const actual = yield* retireErasureSource({
      db: input.configuration.sourceDb,
      fence: { from: fence.from, retired: fence.retired },
    });
    if (
      actual.tablesDigest !== fence.freeze.tablesDigest ||
      actual.triggersDigest !== fence.freeze.triggersDigest ||
      actual.tableCount !== fence.freeze.tableCount ||
      actual.generation !== fence.retired
    ) {
      return yield* new ErasureUnavailable();
    }
    return { ...input.record, phase: "SourceRetired" as const };
  });
