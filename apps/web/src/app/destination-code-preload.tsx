import { type JSX, type RefCallback, useCallback } from "react";
import { destinationCodePreloads } from "./destination-components";

const scheduleIdleCode = (run: () => void): (() => void) => {
  if (typeof requestIdleCallback === "function") {
    const token = requestIdleCallback(run);
    return () => cancelIdleCallback(token);
  }
  const token = requestAnimationFrame(run);
  return () => cancelAnimationFrame(token);
};

/** Code parsing yields between destinations; retirement cancels every unstarted step. */
export const DestinationCodePreload = (): JSX.Element => {
  const attach = useCallback<RefCallback<HTMLSpanElement>>((node) => {
    if (node === null) return;
    let stopped = false;
    let cancel = (): void => undefined;
    const steps = destinationCodePreloads[Symbol.iterator]();
    const enqueue = (): void => {
      if (stopped || !node.isConnected) return;
      cancel = scheduleIdleCode(run);
    };
    const run = (): void => {
      if (stopped || !node.isConnected) return;
      const step = steps.next();
      if (step.done !== true) {
        step
          .value()
          .then(enqueue, enqueue)
          .catch(() => undefined);
      }
    };
    enqueue();
    return (): void => {
      stopped = true;
      cancel();
    };
  }, []);
  return <span hidden ref={attach} />;
};
