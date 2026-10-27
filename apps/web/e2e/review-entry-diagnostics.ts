import type { CDPSession, Page, Request, TestInfo } from "@playwright/test";
import { Cause, Deferred, Effect, Option, Schema } from "effect";
import { dual } from "effect/Function";
import { apiOrigin } from "./http-fixtures";

const traceLimit = 10_000;
const traceBufferKilobytes = 1024;
const traceCategories = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.stack",
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
  ]),
  ph: Schema.Literals(["B", "E", "X", "I", "R", "b", "e", "n"]),
  pid: Schema.Finite,
  tid: Schema.Finite,
  ts: Schema.Finite,
  dur: Schema.optionalKey(Schema.Finite),
});
const TraceSource = Schema.Struct({
  url: Schema.String.check(
    Schema.isPattern(/^https:\/\/127\.0\.0\.1:\d+\/assets\/[A-Za-z0-9_-]{1,160}\.js$/u)
  ),
  lineNumber: Schema.Finite,
  columnNumber: Schema.Finite,
});
const TraceDetail = Schema.Struct({
  elementCount: Schema.optionalKey(Schema.Finite),
  dirtyObjects: Schema.optionalKey(Schema.Finite),
  totalObjects: Schema.optionalKey(Schema.Finite),
  stackTrace: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
type SourceLocation = Omit<typeof TraceSource.Type, "url"> & Readonly<{ asset: string }>;
const sourceLocation = (value: unknown): ReadonlyArray<SourceLocation> =>
  Option.toArray(Schema.decodeUnknownOption(TraceSource)(value)).map(({ url, ...location }) => ({
    ...location,
    asset: url.slice(url.lastIndexOf("/") + 1),
  }));

/** Temporary synthetic-replay attribution: only static bundle locations and numeric counts. */
const stackDepthLimit = 10;
type TraceAttribution = Readonly<{
  attribution: ReadonlyArray<
    Omit<typeof TraceDetail.Type, "stackTrace"> & {
      sources: ReadonlyArray<SourceLocation>;
    }
  >;
}>;
const traceAttribution = (value: unknown): TraceAttribution => {
  const args = Schema.decodeUnknownOption(
    Schema.Struct({
      args: Schema.Struct({
        data: Schema.optionalKey(Schema.Unknown),
        beginData: Schema.optionalKey(Schema.Unknown),
      }),
    })
  )(value);
  if (Option.isNone(args)) return { attribution: [] };
  const details = [args.value.args.data, args.value.args.beginData].flatMap((raw) => {
    const decoded = Schema.decodeUnknownOption(TraceDetail)(raw);
    if (Option.isNone(decoded)) return [];
    const { stackTrace, ...counts } = decoded.value;
    const sources = [
      ...sourceLocation(raw),
      ...(stackTrace ?? []).slice(0, stackDepthLimit).flatMap(sourceLocation),
    ];
    return Object.keys(counts).length === 0 && sources.length === 0 ? [] : [{ ...counts, sources }];
  });
  return { attribution: details };
};

type SafeTraceEvent = typeof TraceEvent.Type & TraceAttribution & Readonly<{ cat: string }>;

/** Upload only fixed event names, numeric timings/counts, and bounded static bundle locations. */
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
          ...traceAttribution(value),
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

const finishTrace = Effect.fnUntraced(function* (
  session: CDPSession,
  trace: ReturnType<typeof collectReviewTrace>,
  information: TestInfo
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
      "One synthetic traced navigation; diagnostic evidence, not a native gate measurement.",
  });
  yield* reviewDiagnosticRequest(() =>
    information.attach("review-return-replay-trace", {
      body: report,
      contentType: "application/json",
    })
  );
});

const cpuSampleIntervalMicroseconds = 100;
const cpuNodeLimit = 10_000;
const cpuSampleLimit = 20_000;
const cpuReportByteLimit = 512_000;
const CpuProfile = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      callFrame: Schema.Unknown,
      children: Schema.optionalKey(Schema.Array(Schema.Finite)),
    })
  ).check(Schema.isMaxLength(cpuNodeLimit)),
  samples: Schema.Array(Schema.Finite).check(Schema.isMaxLength(cpuSampleLimit)),
  timeDeltas: Schema.Array(Schema.Finite).check(Schema.isMaxLength(cpuSampleLimit)),
  startTime: Schema.Finite,
  endTime: Schema.Finite,
});

/** CPU evidence exposes static bundle coordinates, never function names, URLs or arguments. */
export const sanitizeReviewCpuProfile = (value: unknown): string => {
  const profile = Schema.decodeUnknownSync(CpuProfile)(value);
  const report = JSON.stringify({
    ...profile,
    nodes: profile.nodes.map(({ callFrame, ...node }) => ({
      ...node,
      sources: sourceLocation(callFrame),
    })),
  });
  if (new TextEncoder().encode(report).byteLength > cpuReportByteLimit) {
    throw new Error("Review CPU evidence exceeds its byte limit");
  }
  return report;
};

export const finishReviewCpu = ({
  session,
  information,
}: Readonly<{
  session: Pick<CDPSession, "send">;
  information: Pick<TestInfo, "attach">;
}>): Effect.Effect<void, Cause.UnknownError | Cause.TimeoutError> =>
  Effect.gen(function* () {
    const result = yield* reviewDiagnosticRequest(() => session.send("Profiler.stop"));
    const body = yield* Effect.try(() => sanitizeReviewCpuProfile(result.profile));
    yield* reviewDiagnosticRequest(() =>
      information.attach("review-return-cpu-profile", {
        body,
        contentType: "application/json",
      })
    );
  }).pipe(
    Effect.ensuring(
      reviewDiagnosticRequest(() => session.send("Profiler.disable")).pipe(Effect.exit)
    )
  );

const profileReviewCpu = Effect.fnUntraced(function* (session: CDPSession) {
  yield* Effect.addFinalizer(() =>
    reviewDiagnosticRequest(() => session.send("Profiler.disable")).pipe(Effect.exit)
  );
  yield* reviewDiagnosticRequest(() => session.send("Profiler.enable"));
  yield* reviewDiagnosticRequest(() =>
    session.send("Profiler.setSamplingInterval", {
      interval: cpuSampleIntervalMicroseconds,
    })
  );
  yield* Effect.addFinalizer(() =>
    reviewDiagnosticRequest(() => session.send("Profiler.stop")).pipe(Effect.exit)
  );
  yield* reviewDiagnosticRequest(() => session.send("Profiler.start"));
});

const recordReplayDuration = Effect.fnUntraced(function* (page: Page, information: TestInfo) {
  const raw = yield* reviewDiagnosticRequest((signal) =>
    page.locator("body").getAttribute("data-review-replay-milliseconds", { signal })
  );
  const milliseconds = yield* Schema.decodeUnknownEffect(Schema.FiniteFromString)(raw);
  yield* reviewDiagnosticRequest(() =>
    information.attach("review-return-replay-duration", {
      body: `${milliseconds} ms (diagnostic replay only; not a native benchmark)`,
      contentType: "text/plain",
    })
  );
});

const traceReviewReplay = Effect.fnUntraced(function* (
  page: Page,
  information: TestInfo,
  mode: "timeline" | "cpu"
) {
  const session = yield* Effect.acquireRelease(
    reviewDiagnosticRequest(() => page.context().newCDPSession(page)),
    (owned) => reviewDiagnosticRequest(() => owned.detach()).pipe(Effect.exit)
  );
  if (mode === "cpu") yield* profileReviewCpu(session);
  const trace = collectReviewTrace();
  session.on("Tracing.dataCollected", trace.collect);
  yield* Effect.addFinalizer(() =>
    finishTrace(session, trace, information).pipe(
      Effect.interruptible,
      Effect.timeout("2 seconds"),
      Effect.scoped,
      Effect.exit
    )
  );
  yield* reviewDiagnosticRequest(() =>
    session.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: {
        recordMode: "recordUntilFull",
        traceBufferSizeInKb: traceBufferKilobytes,
        includedCategories: traceCategories,
        enableSampling: false,
        enableArgumentFilter: false,
      },
    })
  );
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
  yield* recordReplayDuration(page, information);
  if (mode === "cpu") yield* finishReviewCpu({ session, information });
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
      body: `${Number(original)} ms (original untraced measurement)`,
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
  yield* traceReviewReplay(page, information, "timeline");
});

/** One temporary independent synthetic case; its consumed Page cannot execute mutations. */
export const captureReviewCpuProfile = Effect.fnUntraced(function* (
  page: Page,
  information: TestInfo
) {
  yield* protectReviewReplay(page);
  yield* reviewDiagnosticRequest((signal) =>
    page.getByRole("link", { name: "Transacciones", exact: true }).click({ signal })
  );
  yield* reviewDiagnosticRequest((signal) =>
    page.getByRole("heading", { name: "Transacciones", exact: true }).waitFor({ signal })
  );
  yield* traceReviewReplay(page, information, "cpu");
});
