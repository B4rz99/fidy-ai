import { Clock, Effect, Option, Schema } from "effect";
import { ErasureUnavailable } from "../erasure-store/contract";
import { reconcileErasureAdmissions } from "../erasure/operations";
import {
  type RecoveryActivationEnvironment,
  RecoveryAdmissionState,
  RecoveryTarget,
} from "./contract";
import {
  type ActivationRecord,
  activationIo,
  loadActivation,
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
  Readonly<{ source: RecoveryTarget; serving: RecoveryTarget }>,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    const source = yield* Schema.decodeEffect(RecoveryTarget)(input.configuration.sourceTarget);
    const serving = yield* Schema.decodeEffect(RecoveryTarget)(input.configuration.servingTarget);
    if (source.namespaceId === serving.namespaceId || source.epoch === serving.epoch) {
      return yield* new ErasureUnavailable();
    }
    return { source, serving };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const advancePhase = (
  input: ActivationInput,
  record: ActivationRecord
): Effect.Effect<ActivationRecord, ErasureUnavailable> =>
  Effect.gen(function* () {
    const state = yield* Schema.decodeUnknownEffect(RecoveryAdmissionState)(
      yield* activationIo(() =>
        input.configuration.admission.close({
          activationId: input.activationId,
          epoch: record.source.epoch,
        })
      )
    );
    if (
      !state.closed ||
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
    return {
      ...record,
      cursor: pending.cursor,
      phase: pending.complete ? ("AwaitingProvider" as const) : ("ReconcilingAdmissions" as const),
    };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

/** Advances only fixed binding-selected targets. Local observations never qualify provider isolation or open serving admission. */
export const advanceRecoveryActivation = (
  input: ActivationInput
): Effect.Effect<Response, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* currentActivation(input);
    const targets = yield* requireTargets(input);
    const previous = yield* loadActivation(input.bucket);
    if (
      Option.isSome(previous) &&
      (previous.value.record.activationId !== input.activationId ||
        !sameTarget({ left: previous.value.record.source, right: targets.source }) ||
        !sameTarget({ left: previous.value.record.serving, right: targets.serving }))
    ) {
      return yield* new ErasureUnavailable();
    }
    const record = Option.match(previous, {
      onNone: (): ActivationRecord => ({
        activationId: input.activationId,
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
