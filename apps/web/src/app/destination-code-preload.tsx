import { type JSX, type RefCallback, useCallback, useContext } from "react";
import { DestinationCodeContext } from "./destination-code-context";
import { Option, Schema } from "effect";

const connectionPolicy = Schema.Struct({ saveData: Schema.Boolean, effectiveType: Schema.String });

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
  const destinations = useContext(DestinationCodeContext);
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
      let stopped = false;
      let cancel = (): void => undefined;
      const steps = destinations[Symbol.iterator]();
      const enqueue = (): void => {
        if (stopped || !node.isConnected) return;
        cancel = scheduleIdleCode(run);
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
      return (): void => {
        stopped = true;
        cancel();
      };
    },
    [destinations]
  );
  return <span hidden ref={attach} />;
};
