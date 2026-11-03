import { type ContextType, type JSX, type RefCallback, useCallback, useContext } from "react";
import { DestinationPreloadContext } from "./destination-preload-context";
import { Option, Schema } from "effect";

const connectionPolicy = Schema.Struct({ saveData: Schema.Boolean, effectiveType: Schema.String });
const quietMilliseconds = 1000;

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

const prepareDisplays = (node: HTMLSpanElement, destinations: Destinations): (() => void) => {
  let stopped = false;
  const displays = destinations.display[Symbol.iterator]();
  let displayTimer = 0;
  let displayRunning = false;
  let displayComplete = false;
  const scheduleDisplay = (): void => {
    if (stopped || displayComplete || displayRunning || !node.isConnected) return;
    window.clearTimeout(displayTimer);
    if (document.visibilityState !== "visible") return;
    displayTimer = window.setTimeout(prepareDisplay, quietMilliseconds);
  };
  const settledDisplay = (): void => {
    displayRunning = false;
    scheduleDisplay();
  };
  const prepareDisplay = (): void => {
    if (stopped || !node.isConnected) return;
    if (document.visibilityState !== "visible") return;
    if (!destinations.idle()) {
      scheduleDisplay();
      return;
    }
    const step = displays.next();
    if (step.done === true) {
      displayComplete = true;
      window.removeEventListener("pointerdown", scheduleDisplay, true);
      window.removeEventListener("keydown", scheduleDisplay, true);
      document.removeEventListener("visibilitychange", scheduleDisplay);
      return;
    }
    displayRunning = true;
    step.value
      .prepare()
      .then(settledDisplay, settledDisplay)
      .catch(() => undefined);
  };
  window.addEventListener("pointerdown", scheduleDisplay, { capture: true, passive: true });
  window.addEventListener("keydown", scheduleDisplay, { capture: true, passive: true });
  document.addEventListener("visibilitychange", scheduleDisplay);
  scheduleDisplay();
  return () => {
    stopped = true;
    window.clearTimeout(displayTimer);
    window.removeEventListener("pointerdown", scheduleDisplay, true);
    window.removeEventListener("keydown", scheduleDisplay, true);
    document.removeEventListener("visibilitychange", scheduleDisplay);
  };
};

/** Prepare after foreground readiness, yielding between destinations and stopping on retirement. */
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
      const stopCode = prepareCode(node, destinations);
      const stopDisplays = prepareDisplays(node, destinations);
      return (): void => {
        stopCode();
        stopDisplays();
      };
    },
    [destinations]
  );
  return <span hidden ref={attach} />;
};
