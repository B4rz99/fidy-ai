import { Cause, Console, Effect, Exit, Schema } from "effect";

/** Closed defect categories; callers never pass exception text, stacks or component props. */
export type BrowserDefect =
  | "render_uncaught"
  | "render_caught"
  | "render_recoverable"
  | "runtime_error"
  | "unhandled_rejection"
  | "invalid_response"
  | "client_defect";

const maximumPageDefectRecords = 20;

/** Creates one page-lifetime, bounded, best-effort DevTools defect reporter. */
export const makeBrowserDefectReporter = (): ((error: BrowserDefect) => void) => {
  let exported = 0;
  return (error) => {
    if (exported >= maximumPageDefectRecords) return;
    exported++;
    try {
      Effect.runSync(
        Console.info("fidy.browser.defect", {
          component: "browser",
          operation: "browser.defect",
          error,
        })
      );
    } catch {}
  };
};

/** Shared reporter expires on document replacement and retains no error or User state. */
export const reportBrowserDefect = makeBrowserDefectReporter();

/** Observes generated response decoding without exporting any schema input or raw Cause. */
export const observeBrowserDecode = <A, E, R>(
  response: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  response.pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
        const error = Cause.findErrorOption(exit.cause);
        const defect = Cause.findDefect(exit.cause);
        if (error._tag === "Some" && Schema.isSchemaError(error.value)) {
          reportBrowserDefect("invalid_response");
        } else if (defect._tag === "Success") reportBrowserDefect("client_defect");
      })
    )
  );

/** Installs metadata-only global callbacks; disposal removes both listeners. */
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
