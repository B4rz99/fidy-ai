import { Cause, Console, Effect, Exit, Option, Result, Schema } from "effect";
import { browserRuntime } from "./browser-runtime";

export type BrowserDefect =
  | "render_uncaught"
  | "render_caught"
  | "render_recoverable"
  | "runtime_error"
  | "unhandled_rejection"
  | "invalid_response"
  | "client_defect";

const maximumPageDefectRecords = 20;

export const makeBrowserDefectReporter = (): ((error: BrowserDefect) => void) => {
  let exported = 0;

  return (error) => {
    if (exported >= maximumPageDefectRecords) return;
    exported++;

    try {
      browserRuntime.runSync(
        Console.info("fidy.browser.defect", {
          component: "browser",
          operation: "browser.defect",
          error,
        })
      );
    } catch {}
  };
};

export const reportBrowserDefect = makeBrowserDefectReporter();

export const observeBrowserDecode = <A, E, R>(
  response: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  response.pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
        const error = Cause.findErrorOption(exit.cause);
        const defect = Cause.findDefect(exit.cause);

        if (Option.isSome(error) && Schema.isSchemaError(error.value)) {
          reportBrowserDefect("invalid_response");
        } else if (Result.isSuccess(defect)) reportBrowserDefect("client_defect");
      })
    )
  );

export const installBrowserDefectListeners = (target: Window): (() => void) => {
  const onError = (): void => reportBrowserDefect("runtime_error");
  const onRejection = (): void => reportBrowserDefect("unhandled_rejection");
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);

  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
};
