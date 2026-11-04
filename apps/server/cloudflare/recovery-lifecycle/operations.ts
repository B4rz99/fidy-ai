import { environment as nativeEnvironment } from "./internal/environment";
import { check, epoch } from "./internal/epoch";
import { newId } from "../secret-material/operations";
import { capture, within } from "./internal/context";
import { tracker as makeTracker } from "./internal/tracker";
import { observe } from "./internal/drain";
import { type Effect, Option, Schema } from "effect";
import {
  type RecoveryAdmissionBinding,
  type RecoveryAdmissionEnvironment,
  RecoveryAdmissionState,
  type RecoveryLease,
} from "../recovery-activation/contract";
import {
  type RecoveryDrainObservation,
  type RecoveryDrainUnavailable,
  type RecoveryLifecycleEnvironment,
  type RecoveryNativeEnvironment,
  type RecoveryOperationLease,
  RecoveryOperationUnavailable,
} from "./contract";

const admission = (
  environment: RecoveryAdmissionEnvironment
): Option.Option<
  Readonly<{ gate: RecoveryAdmissionBinding; lease: typeof RecoveryLease.Type }>
> => {
  const namespace = environment.RECOVERY_ADMISSION;
  const epoch = environment.RECOVERY_SOURCE_EPOCH;
  if (namespace === undefined && epoch === undefined) return Option.none();
  if (namespace === undefined || epoch === undefined || epoch === "") {
    throw new RecoveryOperationUnavailable();
  }
  const gate = namespace.getByName("source-admission-v1");
  const lease = { epoch, leaseId: newId() };
  return Option.some({ gate, lease });
};

/** Unknown failures retain the durable lease; only exact, known settlement can release it. */
const admit = (
  environment: RecoveryAdmissionEnvironment,
  continuation: boolean
): Promise<Option.Option<RecoveryOperationLease>> =>
  Promise.resolve().then(() => {
    const selected = admission(environment);
    if (Option.isNone(selected)) return Option.none();
    const { gate, lease } = selected.value;
    const entered = continuation ? gate.enterContinuation(lease) : gate.enter(lease);
    return entered.then((entered) => {
      if (!entered) throw new RecoveryOperationUnavailable();
      let completed = false;
      return Option.some({
        assertOpen: (): Promise<void> =>
          gate.inspect().then((raw) => {
            const state = Schema.decodeUnknownSync(RecoveryAdmissionState)(raw);
            if (state.closed || state.epoch !== lease.epoch) {
              throw new RecoveryOperationUnavailable();
            }
          }),
        complete: (): Promise<void> => {
          if (completed) return Promise.reject(new RecoveryOperationUnavailable());
          completed = true;
          return gate.complete(lease).then((released) => {
            if (!released) throw new RecoveryOperationUnavailable();
          });
        },
      });
    });
  });

/** Ordinary ingress cannot publish new work after the source pause. */
export const admitRecoveryOperation = (
  environment: RecoveryAdmissionEnvironment
): Promise<Option.Option<RecoveryOperationLease>> => admit(environment, false);

/** Only native continuation entrypoints use this capability after verifying the trusted epoch. */
export const admitRecoveryContinuation = (
  environment: RecoveryAdmissionEnvironment
): Promise<Option.Option<RecoveryOperationLease>> => admit(environment, true);

/** Retains admission until the whole native operation settles. */
const run = <A>({
  environment,
  work,
  admitOperation,
}: Readonly<{
  environment: RecoveryAdmissionEnvironment;
  work: () => Promise<A>;
  admitOperation: typeof admitRecoveryOperation;
}>): Promise<A> =>
  admitOperation(environment).then((admitted) => {
    if (Option.isNone(admitted)) return work();
    const tracker = makeTracker();
    return within({ tracker, work }).then((result) =>
      tracker
        .settle()
        .then(() => admitted.value.complete())
        .then(() => result)
    );
  });

/** Retains ordinary ingress until all native children settle. */
export const runRecoveryOperation = <A>(
  input: Readonly<{
    environment: RecoveryAdmissionEnvironment;
    work: () => Promise<A>;
  }>
): Promise<A> => run({ ...input, admitOperation: admitRecoveryOperation });

/** Native continuations retain the source epoch during the publisher pause. */
export const runRecoveryContinuation = <A>(
  input: Readonly<{
    environment: RecoveryAdmissionEnvironment;
    work: () => Promise<A>;
  }>
): Promise<A> => run({ ...input, admitOperation: admitRecoveryContinuation });

/** Each durable execution must belong to the deployment target that admitted its publication. */
export const runRecoveryJob = <A>({
  environment,
  payload,
  work,
}: Readonly<{
  environment: RecoveryLifecycleEnvironment;
  payload: unknown;
  work: (payload: unknown) => Promise<A>;
}>): Promise<A> =>
  Promise.resolve().then(() => {
    checkRecoveryWork({ environment, payload });
    return runRecoveryContinuation({ environment, work: () => work(payload) });
  });

/** Job authority follows the selected immutable target. */
export const recoveryWorkEpoch = (
  environment: RecoveryLifecycleEnvironment
): Option.Option<string> => epoch(environment);

/** Validate trusted publication metadata before native owner work. */
export const checkRecoveryWork = (
  input: Readonly<{ environment: RecoveryLifecycleEnvironment; payload: unknown }>
): void => check(input);

/** Refusing a batch never acknowledges unprocessed native Queue deliveries. */
export const runRecoveryQueue = ({
  environment,
  batch,
  work,
}: Readonly<{
  environment: RecoveryLifecycleEnvironment;
  batch: MessageBatch<unknown>;
  work: () => Promise<void>;
}>): Promise<void> =>
  Promise.resolve().then(() => {
    for (const message of batch.messages) checkRecoveryWork({ environment, payload: message.body });
    return runRecoveryContinuation({ environment, work });
  });

/** Observe fixed source owner standing; provider inventory and namespace history qualify separately. */
export const observeRecoveryDrain = (
  input: Readonly<{ db: D1Database }>
): Effect.Effect<typeof RecoveryDrainObservation.Type, RecoveryDrainUnavailable> => observe(input);

/** Native transport composition captures its current root without receiving an ID or public bypass. */
export const captureRecoveryNativeObserver = (): (<A>(work: () => Promise<A>) => Promise<A>) =>
  capture();

/** Authenticated control owners keep fixed native capabilities and every child Promise in one captured lifetime. */
export const runRecoveryControlOperation = <Environment extends RecoveryNativeEnvironment, A>({
  environment,
  work,
}: Readonly<{
  environment: Environment;
  work: (owned: Environment) => Promise<A>;
}>): Promise<A> => {
  const tracker = makeTracker();
  return within({ tracker, work: () => work(nativeEnvironment(environment)) }).then((result) =>
    tracker.settle().then(() => result)
  );
};
