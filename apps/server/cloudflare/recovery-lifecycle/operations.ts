import { newId } from "../secret-material/operations";
import { within } from "./internal/context";
import { tracker as makeTracker } from "./internal/tracker";
import { Option, Schema } from "effect";
import {
  type RecoveryAdmissionBinding,
  type RecoveryAdmissionEnvironment,
  RecoveryAdmissionState,
  type RecoveryLease,
} from "../recovery-activation/contract";
import {
  type RecoveryLifecycleEnvironment,
  type RecoveryOperationLease,
  RecoveryOperationUnavailable,
  RecoveryWorkMetadata,
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

/** Job authority follows the selected immutable target; legacy unqualified fixtures have no epoch. */
export const recoveryWorkEpoch = (
  environment: RecoveryLifecycleEnvironment
): Option.Option<string> => {
  const source = Option.fromUndefinedOr(environment.RECOVERY_SOURCE_EPOCH);
  const store = Option.fromUndefinedOr(environment.SQLITE_STORE_EPOCH);
  if (Option.isSome(source) && Option.isSome(store) && source.value !== store.value) {
    throw new RecoveryOperationUnavailable();
  }
  const epoch = Option.orElse(source, () => store);
  return Option.map(
    epoch,
    (value) => Schema.decodeSync(RecoveryWorkMetadata)({ recoveryEpoch: value }).recoveryEpoch
  );
};

const WorkMetadataPresence = Schema.Struct({ recoveryEpoch: Schema.Unknown });
/** Stale or unstamped durable work is refused before a store or provider can be reached. */
export const checkRecoveryWork = ({
  environment,
  payload,
}: Readonly<{
  environment: RecoveryLifecycleEnvironment;
  payload: unknown;
}>): void => {
  const expected = recoveryWorkEpoch(environment);
  const metadata = Schema.decodeUnknownOption(RecoveryWorkMetadata)(payload);
  if (Option.isNone(expected)) {
    if (Option.isSome(Schema.decodeUnknownOption(WorkMetadataPresence)(payload))) {
      throw new RecoveryOperationUnavailable();
    }
    return;
  }
  if (Option.isNone(metadata) || metadata.value.recoveryEpoch !== expected.value) {
    throw new RecoveryOperationUnavailable();
  }
};

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
