import { Clock, Effect, Option, Schema } from "effect";
import { ErasureUnavailable } from "../erasure-store/contract";
import { RecoveryDrainObservation } from "../recovery-lifecycle/contract";
import { observeRecoveryDrain } from "../recovery-lifecycle/operations";
import { reconcileErasureAdmissions } from "../erasure/operations";
import {
  type RecoveryActivationEnvironment,
  RecoveryAdmissionState,
  RecoverySourceTarget,
  RecoveryTarget,
} from "./contract";
import {
  type ActivationRecord,
  activationIo,
  loadActivation,
  sameSource,
  sameTarget,
  storeActivation,
} from "./internal/record";

type ActivationInput = Readonly<{
  activationId: string;
  configuration: RecoveryActivationEnvironment;
  bucket: R2Bucket;
  signal: AbortSignal;
  expiresAtMs: number;
}>;
const currentActivation = (input: ActivationInput): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (input.signal.aborted || current >= input.expiresAtMs) {
      return yield* new ErasureUnavailable();
    }
  });
const requireTargets = (
  input: ActivationInput
): Effect.Effect<
  Readonly<{ source: RecoverySourceTarget; serving: RecoveryTarget }>,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    const source = yield* Schema.decodeEffect(RecoverySourceTarget)(
      input.configuration.sourceTarget
    );
    const serving = yield* Schema.decodeEffect(RecoveryTarget)(input.configuration.servingTarget);
    if (
      (source.kind === "SQLite" && source.namespaceId === serving.namespaceId) ||
      source.epoch === serving.epoch
    ) {
      return yield* new ErasureUnavailable();
    }
    return { source, serving };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const awaitOwnerDrain = (
  input: ActivationInput,
  record: ActivationRecord
): Effect.Effect<ActivationRecord, ErasureUnavailable> =>
  Effect.gen(function* () {
    const observation = yield* observeRecoveryDrain({ db: input.configuration.sourceDb });
    const drain = yield* Schema.decodeEffect(RecoveryDrainObservation, {
      onExcessProperty: "error",
    })(observation);
    const owners = Object.values(drain.owners);
    const pending = owners.reduce((total, owner) => total + owner.pending, 0);
    const ambiguous = owners.reduce((total, owner) => total + owner.ambiguous, 0);
    if (pending !== drain.pending || ambiguous !== drain.ambiguous) {
      return yield* new ErasureUnavailable();
    }
    if (drain.pending !== 0 || drain.ambiguous !== 0) {
      return { ...record, cursor: "", phase: "AwaitingOwnerDrain" as const };
    }
    // Owner rows cannot prove identity-free Queue/Workflow inventory or historical caller fencing.
    // Keep native continuations admissible until the independent provider barrier is established.
    return { ...record, cursor: "", phase: "AwaitingProvider" as const };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const advancePhase = (
  input: ActivationInput,
  record: ActivationRecord
): Effect.Effect<ActivationRecord, ErasureUnavailable> =>
  Effect.gen(function* () {
    const state = yield* Schema.decodeUnknownEffect(RecoveryAdmissionState)(
      yield* activationIo(() =>
        input.configuration.admission.pause({
          activationId: input.activationId,
          epoch: record.source.epoch,
        })
      )
    );
    if (
      !state.paused ||
      state.activationId !== input.activationId ||
      state.epoch !== record.source.epoch
    ) {
      return yield* new ErasureUnavailable();
    }
    if (state.leases > 0) return { ...record, phase: "AwaitingDrain" as const, cursor: "" };
    const pending = yield* reconcileErasureAdmissions({
      db: input.configuration.sourceDb,
      bucket: input.bucket,
      cursor: record.cursor,
    });
    if (!pending.complete) {
      return { ...record, cursor: pending.cursor, phase: "ReconcilingAdmissions" as const };
    }
    return yield* awaitOwnerDrain(input, record);
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

/** Advances only fixed binding-selected targets. Local observations never qualify provider isolation or open serving admission. */
export const advanceRecoveryActivation = (
  input: ActivationInput
): Effect.Effect<Response, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* currentActivation(input);
    const targets = yield* requireTargets(input);
    const previous = yield* loadActivation(input.bucket);
    const admission = yield* Schema.decodeUnknownEffect(RecoveryAdmissionState)(
      yield* activationIo(() => input.configuration.admission.inspect())
    );
    if (
      Option.isSome(previous) &&
      (previous.value.record.activationId !== input.activationId ||
        previous.value.record.admissionObjectId !== admission.objectId ||
        !sameSource({ left: previous.value.record.source, right: targets.source }) ||
        !sameTarget({ left: previous.value.record.serving, right: targets.serving }))
    ) {
      return yield* new ErasureUnavailable();
    }
    const record = Option.match(previous, {
      onNone: (): ActivationRecord => ({
        activationId: input.activationId,
        admissionObjectId: admission.objectId,
        ...targets,
        cursor: "",
        phase: "AwaitingDrain",
        providerIsolation: "Unqualified",
      }),
      onSome: (value) => value.record,
    });
    const advanced = yield* advancePhase(input, record);
    yield* currentActivation(input);
    return yield* storeActivation({ bucket: input.bucket, record: advanced, previous });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
