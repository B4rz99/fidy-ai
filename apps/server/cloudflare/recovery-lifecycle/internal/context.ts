import { AsyncLocalStorage } from "node:async_hooks";
import type { RecoveryLifecycleEnvironment, RecoveryNativeTracker } from "../contract";
import { RecoveryOperationUnavailable } from "../contract";

const context = new AsyncLocalStorage<RecoveryNativeTracker>();

export const within = <A>({
  tracker,
  work,
}: Readonly<{
  tracker: RecoveryNativeTracker;
  work: () => A;
}>): A => context.run(tracker, work);

export const native = <A>({
  environment,
  work,
}: Readonly<{
  environment: RecoveryLifecycleEnvironment;
  work: () => Promise<A>;
}>): Promise<A> => {
  if (
    environment.RECOVERY_ADMISSION === undefined &&
    environment.RECOVERY_SOURCE_EPOCH === undefined
  ) {
    return work();
  }
  const tracker = context.getStore();
  return tracker === undefined
    ? Promise.reject(new RecoveryOperationUnavailable())
    : tracker.run(work);
};

/** Capture the private root once; stream callbacks can later run outside its async resource. */
export const capture = (): (<A>(work: () => Promise<A>) => Promise<A>) => {
  const tracker = context.getStore();
  return <A>(work: () => Promise<A>): Promise<A> =>
    tracker === undefined ? work() : tracker.run(work);
};
