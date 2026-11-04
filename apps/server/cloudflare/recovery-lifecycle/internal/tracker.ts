import type { RecoveryNativeTracker } from "../contract";
import { RecoveryOperationUnavailable } from "../contract";

const invoke = <A>(work: () => Promise<A>): Promise<A> => {
  try {
    return work();
  } catch (failure) {
    return Promise.reject(failure);
  }
};

/** A rejected child is unknown settlement; removing its local Promise never clears its durable root. */
export const tracker = (): RecoveryNativeTracker => {
  const pending = new Set<Promise<unknown>>();
  let active = true;
  let unknown = false;
  const settle = (): Promise<void> => {
    if (pending.size > 0) return Promise.allSettled(pending).then(settle);
    active = false;
    return unknown ? Promise.reject(new RecoveryOperationUnavailable()) : Promise.resolve();
  };
  return {
    run: <A>(work: () => Promise<A>): Promise<A> => {
      if (!active) return Promise.reject(new RecoveryOperationUnavailable());
      const child = invoke(work);
      pending.add(child);
      child.then(
        () => {
          pending.delete(child);
        },
        () => {
          unknown = true;
          pending.delete(child);
        }
      );
      return child;
    },
    settle,
  };
};
