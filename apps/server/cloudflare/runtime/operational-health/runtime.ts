import { Effect } from "effect";
import type { CoreRejectionBoundary } from "./contract";

const minuteMs = 60_000;

const burstThreshold = 100;

const unauthorizedStatus = 401;

const forbiddenStatus = 403;

const badRequestStatus = 400;

const unprocessableStatus = 422;

const serverErrorStatus = 500;

const observedRefusal = (boundary: CoreRejectionBoundary, status: number): boolean => {
  if (status === unauthorizedStatus || status === forbiddenStatus) return true;

  if (boundary === "providerCallback") {
    return status === badRequestStatus || status === unprocessableStatus;
  }

  return boundary === "mcp" && status >= badRequestStatus && status < serverErrorStatus;
};

export const coreRejectionObserver = (): ((
  input: Readonly<{
    status: number;
    boundary: CoreRejectionBoundary;
    now: number;
  }>
) => Effect.Effect<void>) => {
  let minute = -1;
  let refusals = 0;

  return ({ status, boundary, now }) =>
    Effect.suspend(() => {
      if (!observedRefusal(boundary, status)) return Effect.void;
      const observedAtMs = Math.floor(now / minuteMs) * minuteMs;

      if (observedAtMs < minute) return Effect.void;

      if (observedAtMs > minute) {
        minute = observedAtMs;
        refusals = 0;
      }

      if (refusals >= burstThreshold) return Effect.void;
      refusals += 1;

      if (refusals < burstThreshold) return Effect.void;

      return Effect.logWarning({
        component: "core-rejections",
        operation: "coreRejectionBursts",
        state: "attention",
        message:
          "fidy.operational component=core-rejections operation=coreRejectionBursts state=attention severity=warning",
      }).pipe(Effect.catchDefect(() => Effect.void));
    });
};
