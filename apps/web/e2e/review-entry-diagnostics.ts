import type { CDPSession, Page, Request, TestInfo } from "@playwright/test";
import { Cause, Config, Deferred, Effect, Option, Schema } from "effect";
import { dual } from "effect/Function";
import { apiOrigin } from "./http-fixtures";

const traceLimit = 10_000;
const traceBufferKilobytes = 1024;
const traceCategories = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "blink.user_timing",
  "v8",
];

/** Bound waiting even inside masked acquisition/finalization; the failed Page owns late resources. */
export const reviewDiagnosticRequest = <A>(
  request: (signal: AbortSignal) => Promise<A>
): Effect.Effect<A, Cause.UnknownError | Cause.TimeoutError> =>
  Effect.tryPromise(request).pipe(Effect.interruptible, Effect.timeout("1 second"));

type ReplayRoute = Readonly<{
  request: () => Pick<Request, "method">;
  fallback: () => Promise<void>;
  fulfill: (response: Readonly<{ status: number; body: string }>) => Promise<void>;
}>;

export const reviewReplayGuard = (): Readonly<{
  route: (request: ReplayRoute) => Promise<void>;
  blocked: () => number;
}> => {
  let blocked = 0;
  return {
    route: (request) => {
      if (["GET", "HEAD", "OPTIONS"].includes(request.request().method())) {
        return request.fallback();
      }
      blocked++;
      return request.fulfill({ status: 405, body: "" });
    },
    blocked: () => blocked,
  };
};
/** The failed Page owns the guard until its fixture disposes it, even after uncertain close. */
export const protectReviewReplay = Effect.fnUntraced(function* (
  page: Pick<Page, "route" | "close">
) {
  const guard = reviewReplayGuard();
  yield* Effect.addFinalizer(() => reviewDiagnosticRequest(() => page.close()).pipe(Effect.exit));
  yield* reviewDiagnosticRequest(() => page.route(`${apiOrigin}/**`, guard.route));
  return guard;
});

export const ReviewTraceCompletion = Schema.Struct({ dataLossOccurred: Schema.Boolean });

const TraceEvent = Schema.Struct({
  name: Schema.Literals([
    "RunTask",
    "RunMicrotasks",
    "EventDispatch",
    "FunctionCall",
    "EvaluateScript",
    "TimerFire",
    "FireAnimationFrame",
    "UpdateLayoutTree",
    "Layout",
    "PrePaint",
    "Paint",
    "Commit",
    "CompositeLayers",
    "MinorGC",
    "MajorGC",
    "V8.GCScavenger",
    "V8.GCCompactor",
    "fidy-review-replay-start",
    "fidy-review-replay-visible",
    "fidy-review-native-start",
    "fidy-review-native-visible",
  ]),
  ph: Schema.Literals(["B", "E", "X", "I", "R", "b", "e", "n"]),
  pid: Schema.Finite,
  tid: Schema.Finite,
  ts: Schema.Finite,
  dur: Schema.optionalKey(Schema.Finite),
});
type SafeTraceEvent = typeof TraceEvent.Type & Readonly<{ cat: string }>;

/** Only fixed event names and numeric timing fields may enter the uploaded trace. */
export const collectReviewTrace = (): Readonly<{
  collect: (event: unknown) => void;
  snapshot: () => Readonly<{ traceEvents: ReadonlyArray<SafeTraceEvent>; truncated: boolean }>;
}> => {
  const traceEvents: Array<SafeTraceEvent> = [];
  let truncated = false;
  return {
    collect: (event) => {
      const collection = Schema.decodeUnknownOption(
        Schema.Struct({ value: Schema.Array(Schema.Unknown) })
      )(event);
      if (Option.isNone(collection)) return;
      for (const value of collection.value.value) {
        const decoded = Schema.decodeUnknownOption(TraceEvent)(value);
        if (Option.isNone(decoded)) continue;
        if (traceEvents.length === traceLimit) {
          truncated = true;
          continue;
        }
        traceEvents.push({
          ...decoded.value,
          cat: decoded.value.name.startsWith("fidy-") ? "blink.user_timing" : "devtools.timeline",
        });
      }
    },
    snapshot: () => ({ traceEvents: [...traceEvents], truncated }),
  };
};

/** Evidence runs once after failure, never replacing the original result or its timing. */
export const withReviewEntryEvidence: {
  <E2, R2>(
    evidence: Effect.Effect<void, E2, R2>
  ): <E, R>(measurement: Effect.Effect<void, E, R>) => Effect.Effect<void, E, R | R2>;
  <E, R, E2, R2>(
    measurement: Effect.Effect<void, E, R>,
    evidence: Effect.Effect<void, E2, R2>
  ): Effect.Effect<void, E, R | R2>;
} = dual(
  2,
  <E, R, E2, R2>(
    measurement: Effect.Effect<void, E, R>,
    evidence: Effect.Effect<void, E2, R2>
  ): Effect.Effect<void, E, R | R2> =>
    measurement.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          evidence.pipe(
            Effect.timeout("5 seconds"),
            Effect.exit,
            Effect.andThen(Effect.failCause(cause))
          )
      )
    )
);

const markReviewReplay = (): (() => void) => {
  delete document.body.dataset.reviewReplayMilliseconds;
  let disposeObserver = (): void => {};
  const start = (): void => {
    performance.mark("fidy-review-replay-start");
    const started = performance.now();
    const observer = new MutationObserver(() => {
      const input = document.getElementById("review-amount");
      if (input === null || input.getClientRects().length === 0) return;
      performance.mark("fidy-review-replay-visible");
      document.body.dataset.reviewReplayMilliseconds = String(performance.now() - started);
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    disposeObserver = (): void => observer.disconnect();
  };
  document.addEventListener("click", start, { capture: true, once: true });
  return () => {
    document.removeEventListener("click", start, true);
    disposeObserver();
    performance.clearMarks("fidy-review-replay-start");
    performance.clearMarks("fidy-review-replay-visible");
  };
};

const releaseReplay = (release: () => void): void => release();

type TraceJourney = "original" | "replay";

const finishTrace = Effect.fnUntraced(function* (
  session: CDPSession,
  trace: ReturnType<typeof collectReviewTrace>,
  { information, journey }: Readonly<{ information: TestInfo; journey: TraceJourney }>
) {
  const completed = yield* Deferred.make<boolean, Schema.SchemaError>();
  const context = yield* Effect.context<never>();
  const complete = (event: unknown): void => {
    const decoded = Schema.decodeUnknownEffect(ReviewTraceCompletion)(event).pipe(
      Effect.map((value) => value.dataLossOccurred)
    );
    Effect.runSyncWith(context)(Deferred.complete(completed, decoded));
  };
  session.once("Tracing.tracingComplete", complete);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      session.off("Tracing.tracingComplete", complete);
    })
  );
  yield* reviewDiagnosticRequest(() => session.send("Tracing.end"));
  const dataLossOccurred = yield* Deferred.await(completed);
  const report = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    ...trace.snapshot(),
    displayTimeUnit: "ms",
    dataLossOccurred,
    limitation:
      journey === "original"
        ? "Instrumented first return: explicit-time marks identify the native samples, but CDP tracing adds overhead. Not an uninstrumented gate measurement."
        : "One warmer traced replay after failure; not a replacement gate measurement.",
  });
  yield* reviewDiagnosticRequest(() =>
    information.attach(`review-return-${journey}-trace`, {
      body: report,
      contentType: "application/json",
    })
  );
});

const startReviewTrace = Effect.fnUntraced(function* (
  page: Page,
  information: TestInfo,
  journey: TraceJourney
) {
  const session = yield* Effect.acquireRelease(
    reviewDiagnosticRequest(() => page.context().newCDPSession(page)),
    (owned) => reviewDiagnosticRequest(() => owned.detach()).pipe(Effect.exit)
  );
  const trace = collectReviewTrace();
  session.on("Tracing.dataCollected", trace.collect);
  let stopped = false;
  const stop = Effect.suspend(() => {
    if (stopped) return Effect.void;
    stopped = true;
    return finishTrace(session, trace, { information, journey }).pipe(
      Effect.interruptible,
      Effect.timeout("2 seconds"),
      Effect.scoped,
      Effect.exit,
      Effect.asVoid
    );
  });
  yield* Effect.addFinalizer(() => stop);
  yield* reviewDiagnosticRequest(() =>
    session.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: {
        recordMode: "recordUntilFull",
        traceBufferSizeInKb: traceBufferKilobytes,
        includedCategories: traceCategories,
        enableSampling: false,
        enableArgumentFilter: true,
      },
    })
  );
  return { stop };
});

/** Temporary traced first-return evidence; never an uninstrumented gate pass. */
export const traceOriginalReviewReturn = Effect.fnUntraced(function* (
  page: Page,
  information: TestInfo,
  destination: "Presupuestos" | "Transacciones"
) {
  if (destination !== "Transacciones") return { enabled: false, stop: Effect.void };
  const enabled = yield* Config.String("FIDY_REVIEW_NATIVE_TRACE").pipe(Config.withDefault(""));
  if (enabled !== "1") return { enabled: false, stop: Effect.void };
  information.annotations.push({
    type: "instrumented-original-return",
    description:
      "CDP tracing adds overhead; native-sample marks are emitted after measurement. Not an uninstrumented gate pass.",
  });
  const trace = yield* startReviewTrace(page, information, "original");
  return { enabled: true, stop: trace.stop };
});

const traceReviewReplay = Effect.fnUntraced(function* (page: Page, information: TestInfo) {
  yield* startReviewTrace(page, information, "replay");
  yield* Effect.acquireRelease(
    reviewDiagnosticRequest(() => page.evaluateHandle(markReviewReplay)),
    (cleanup) =>
      reviewDiagnosticRequest(() => cleanup.evaluate(releaseReplay)).pipe(
        Effect.ensuring(reviewDiagnosticRequest(() => cleanup.dispose()).pipe(Effect.exit)),
        Effect.exit
      )
  );
  yield* reviewDiagnosticRequest((signal) =>
    page.getByRole("link", { name: /^Por revisar/u }).click({ signal })
  );
  yield* reviewDiagnosticRequest((signal) =>
    page.waitForFunction(
      () => document.body.dataset.reviewReplayMilliseconds !== undefined,
      undefined,
      { signal }
    )
  );
  const raw = yield* reviewDiagnosticRequest((signal) =>
    page.locator("body").getAttribute("data-review-replay-milliseconds", { signal })
  );
  const milliseconds = yield* Schema.decodeUnknownEffect(Schema.FiniteFromString)(raw);
  yield* reviewDiagnosticRequest(() =>
    information.attach("review-return-replay-duration", {
      body: `${milliseconds} ms (warmer traced replay; original failure preserved)`,
      contentType: "text/plain",
    })
  );
});

/** Consumes the failed Page with one read-only replay, then closes it; never traces authentication. */
export const captureReviewEntryReplay = Effect.fnUntraced(function* (
  page: Page,
  information: TestInfo
) {
  const guard = yield* protectReviewReplay(page);
  const original = yield* reviewDiagnosticRequest((signal) =>
    page.locator("body").getAttribute("data-review-entry-milliseconds", { signal })
  );
  yield* reviewDiagnosticRequest(() =>
    information.attach("review-entry-failed-duration", {
      body: information.annotations.some(
        (annotation) => annotation.type === "instrumented-original-return"
      )
        ? `${Number(original)} ms (original instrumented measurement; tracing adds overhead)`
        : `${Number(original)} ms (original untraced measurement)`,
      contentType: "text/plain",
    })
  ).pipe(Effect.exit);
  yield* Effect.addFinalizer(() =>
    reviewDiagnosticRequest(() =>
      information.attach("review-return-replay-safety", {
        body: `Blocked mutations: ${guard.blocked()}. Synthetic read-only navigation only.`,
        contentType: "text/plain",
      })
    ).pipe(Effect.exit)
  );
  yield* reviewDiagnosticRequest((signal) =>
    page.getByRole("link", { name: "Transacciones", exact: true }).click({ signal })
  );
  yield* reviewDiagnosticRequest((signal) =>
    page.getByRole("heading", { name: "Transacciones", exact: true }).waitFor({ signal })
  );
  yield* traceReviewReplay(page, information);
});
