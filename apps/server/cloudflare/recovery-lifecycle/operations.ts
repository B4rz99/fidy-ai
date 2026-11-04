import { newId } from "../secret-material/operations";
import { Option, Schema } from "effect";
import {
  type RecoveryAdmissionBinding,
  type RecoveryAdmissionEnvironment,
  RecoveryAdmissionState,
  type RecoveryLease,
} from "../recovery-activation/contract";
import { type RecoveryOperationLease, RecoveryOperationUnavailable } from "./contract";

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
export const admitRecoveryOperation = (
  environment: RecoveryAdmissionEnvironment
): Promise<Option.Option<RecoveryOperationLease>> =>
  Promise.resolve().then(() => {
    const selected = admission(environment);
    if (Option.isNone(selected)) return Option.none();
    const { gate, lease } = selected.value;
    return gate.enter(lease).then((entered) => {
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

/** Retains admission until the whole native operation settles. */
export const runRecoveryOperation = <A>({
  environment,
  work,
}: Readonly<{
  environment: RecoveryAdmissionEnvironment;
  work: () => Promise<A>;
}>): Promise<A> =>
  admitRecoveryOperation(environment).then((admitted) =>
    work().then((result) =>
      Option.match(admitted, {
        onNone: () => Promise.resolve(result),
        onSome: (lease) => lease.complete().then(() => result),
      })
    )
  );
