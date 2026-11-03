import { type ContextType, type JSX, type RefCallback, useCallback, useContext } from "react";
import { DestinationPreloadContext } from "./destination-preload-context";
import { Option, Schema } from "effect";

const connectionPolicy = Schema.Struct({ saveData: Schema.Boolean, effectiveType: Schema.String });

const scheduleIdlePreparation = (run: () => void): (() => void) => {
  if (typeof requestIdleCallback === "function") {
    const token = requestIdleCallback(run);
    return () => cancelIdleCallback(token);
  }
  const token = requestAnimationFrame(run);
  return () => cancelAnimationFrame(token);
};

type Destinations = ContextType<typeof DestinationPreloadContext>;

const prepareCode = (node: HTMLSpanElement, destinations: Destinations): (() => void) => {
  let stopped = false;
  let cancel = (): void => undefined;
  const steps = destinations.code[Symbol.iterator]();
  const enqueue = (): void => {
    if (stopped || !node.isConnected) return;
    cancel = scheduleIdlePreparation(run);
  };
  const run = (): void => {
    if (stopped || !node.isConnected) return;
    const step = steps.next();
    if (step.done !== true) {
      step.value
        .load()
        .then(enqueue, enqueue)
        .catch(() => undefined);
    }
  };
  enqueue();
  return () => {
    stopped = true;
    cancel();
  };
};

/** Load destination code after foreground readiness; no destination data reads are scheduled. */
export const DestinationPreload = (): JSX.Element => {
  const destinations = useContext(DestinationPreloadContext);
  const attach = useCallback<RefCallback<HTMLSpanElement>>(
    (node) => {
      if (node === null) return;
      const connection = Schema.decodeUnknownOption(connectionPolicy)(
        Reflect.get(navigator, "connection")
      );
      if (
        Option.exists(
          connection,
          (value) => value.saveData || ["slow-2g", "2g", "3g"].includes(value.effectiveType)
        )
      ) {
        return;
      }
      return prepareCode(node, destinations);
    },
    [destinations]
  );
  return <span hidden ref={attach} />;
};
