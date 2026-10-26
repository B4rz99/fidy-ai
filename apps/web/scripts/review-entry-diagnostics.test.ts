import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";
import type { Page } from "@playwright/test";
import { TestClock } from "effect/testing";
import {
  ReviewTraceCompletion,
  collectReviewTrace,
  protectReviewReplay,
  reviewDiagnosticRequest,
  reviewReplayGuard,
  withReviewEntryEvidence,
} from "../e2e/review-entry-diagnostics";

it("trace completion rejects malformed metadata instead of uploading it", () => {
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(ReviewTraceCompletion)({
        dataLossOccurred: { unsafe: "synthetic-private-metadata" },
      })
    )
  ).toBe(true);
  expect(
    Schema.decodeUnknownSync(ReviewTraceCompletion)({
      dataLossOccurred: false,
      unsafe: "discarded",
    })
  ).toEqual({ dataLossOccurred: false });
});

it.effect("uncertain Page closure retains the installed mutation guard", () =>
  Effect.gen(function* () {
    const closing = yield* Deferred.make<void>();
    const context = yield* Effect.context<never>();
    const installed: Array<Parameters<Page["route"]>[1]> = [];
    const page: Pick<Page, "route" | "close"> = {
      route: (_url, handler) => {
        installed.push(handler);
        const dispose = (): Promise<void> => {
          installed.length = 0;
          return Promise.resolve();
        };
        return Promise.resolve({ dispose, [Symbol.asyncDispose]: dispose });
      },
      close: () => {
        Effect.runSyncWith(context)(Deferred.succeed(closing, undefined));
        return Promise.withResolvers<void>().promise;
      },
    };
    let retained = Option.none<ReturnType<typeof reviewReplayGuard>>();
    const evidence = Effect.gen(function* () {
      retained = Option.some(yield* protectReviewReplay(page));
    }).pipe(Effect.scoped);
    const failure = { _tag: "MeasurementExceeded", milliseconds: 15 };
    const result = yield* withReviewEntryEvidence(Effect.fail(failure), evidence).pipe(
      Effect.exit,
      Effect.forkChild
    );
    yield* Deferred.await(closing);
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(result)).toEqual(Exit.fail(failure));
    const guard = Option.getOrThrow(retained);
    expect(installed).toEqual([guard.route]);
    let downstream = 0;
    let refused = false;
    yield* Effect.tryPromise(() =>
      guard.route({
        request: () => ({ method: (): string => "POST" }),
        fallback: () => {
          downstream++;
          return Promise.resolve();
        },
        fulfill: ({ status }) => {
          refused = status === 405;
          return Promise.resolve();
        },
      })
    );
    expect(refused).toBe(true);
    expect(downstream).toBe(0);
  })
);

it.effect("the replay guard refuses every mutation before any downstream effect", () =>
  Effect.gen(function* () {
    const guard = reviewReplayGuard();
    let downstream = 0;
    const refusals: Array<number> = [];
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "UNRECOGNIZED"]) {
      yield* Effect.tryPromise(() =>
        guard.route({
          request: () => ({ method: (): string => method }),
          fallback: () => {
            downstream++;
            return Promise.resolve();
          },
          fulfill: ({ status }) => {
            refusals.push(status);
            return Promise.resolve();
          },
        })
      );
    }
    expect(downstream).toBe(0);
    expect(refusals).toEqual([405, 405, 405, 405, 405]);
    expect(guard.blocked()).toBe(5);
  })
);

it.effect("the replay guard allows only read methods to reach existing fixtures", () =>
  Effect.gen(function* () {
    const guard = reviewReplayGuard();
    let downstream = 0;
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      yield* Effect.tryPromise(() =>
        guard.route({
          request: () => ({ method: (): string => method }),
          fallback: () => {
            downstream++;
            return Promise.resolve();
          },
          fulfill: () => Promise.reject(new Error("read was refused")),
        })
      );
    }
    expect(downstream).toBe(3);
    expect(guard.blocked()).toBe(0);
  })
);

for (const phase of ["acquire", "dispose"] as const) {
  it.effect(`a stalled foreign ${phase} is bounded even in masked resource ownership`, () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let aborted = false;
      const stalled = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(
          reviewDiagnosticRequest((signal) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
              },
              { once: true }
            );
            return Promise.withResolvers<void>().promise;
          })
        )
      );
      const evidence =
        phase === "acquire"
          ? Effect.acquireRelease(stalled, () => Effect.void)
          : Effect.acquireRelease(Effect.void, () => stalled.pipe(Effect.exit));
      const failure = { _tag: "MeasurementExceeded", milliseconds: 15 };
      const result = yield* withReviewEntryEvidence(
        Effect.fail(failure),
        evidence.pipe(Effect.scoped)
      ).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(result)).toEqual(Exit.fail(failure));
      expect(aborted).toBe(true);
    })
  );
}

it.effect("a diagnostic replay cannot replace the original failed measurement", () =>
  Effect.gen(function* () {
    const failure = { _tag: "MeasurementExceeded", milliseconds: 15 };
    let replays = 0;
    const result = yield* withReviewEntryEvidence(
      Effect.fail(failure),
      Effect.sync(() => {
        replays++;
      })
    ).pipe(Effect.exit);
    expect(result).toEqual(Exit.fail(failure));
    expect(replays).toBe(1);
  })
);

it.effect("a failed diagnostic still preserves the measured failure", () =>
  Effect.gen(function* () {
    const failure = { _tag: "MeasurementExceeded", milliseconds: 11 };
    const result = yield* withReviewEntryEvidence(
      Effect.fail(failure),
      Effect.die("diagnostic unavailable")
    ).pipe(Effect.exit);
    expect(result).toEqual(Exit.fail(failure));
  })
);

it.effect("successful measurements do not run a replay", () =>
  Effect.gen(function* () {
    let replayed = false;
    yield* withReviewEntryEvidence(
      Effect.void,
      Effect.sync(() => {
        replayed = true;
      })
    );
    expect(replayed).toBe(false);
  })
);

it.effect("diagnostic timeout restores the original failure after bounded work", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const failure = { _tag: "MeasurementExceeded", milliseconds: 15 };
    const result = yield* Effect.fail(failure).pipe(
      withReviewEntryEvidence(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
      ),
      Effect.exit,
      Effect.forkChild
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(result)).toEqual(Exit.fail(failure));
  })
);

it.effect("interrupted measurements do not begin diagnostic work", () =>
  Effect.gen(function* () {
    let replayed = false;
    const result = yield* withReviewEntryEvidence(
      Effect.interrupt,
      Effect.sync(() => {
        replayed = true;
      })
    ).pipe(Effect.exit);
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
    expect(replayed).toBe(false);
  })
);

it("trace evidence keeps only known timing fields, not URLs, arguments or arbitrary marks", () => {
  const trace = collectReviewTrace();
  trace.collect(null);
  trace.collect({
    value: [
      {
        name: "Layout",
        cat: "secret-category",
        ph: "X",
        pid: 1,
        tid: 2,
        ts: 1000,
        dur: 3000,
        args: {
          url: "https://example.test/private",
          token: "synthetic-secret",
          data: "private text",
        },
      },
      { name: "private-email@example.test", ph: "R", pid: 1, tid: 2, ts: 2000 },
      { name: "ResourceSendRequest", ph: "I", pid: 1, tid: 2, ts: 2100 },
      { name: "Layout", ph: "X", pid: 1, tid: 2, ts: Number.NaN },
    ],
  });
  expect(trace.snapshot()).toEqual({
    traceEvents: [
      { name: "Layout", cat: "devtools.timeline", ph: "X", pid: 1, tid: 2, ts: 1000, dur: 3000 },
    ],
    truncated: false,
  });
});

it("trace accumulation is bounded and retains fixed replay markers", () => {
  const trace = collectReviewTrace();
  trace.collect({
    value: [{ name: "fidy-review-replay-start", ph: "R", pid: 1, tid: 2, ts: 1000 }],
  });
  trace.collect({
    value: Array.from({ length: 10_001 }, () => ({
      name: "Layout",
      ph: "X",
      pid: 1,
      tid: 2,
      ts: 2000,
      dur: 100,
    })),
  });
  const result = trace.snapshot();
  expect(result.traceEvents).toHaveLength(10_000);
  expect(result.truncated).toBe(true);
  expect(result.traceEvents[0]).toEqual({
    name: "fidy-review-replay-start",
    cat: "blink.user_timing",
    ph: "R",
    pid: 1,
    tid: 2,
    ts: 1000,
  });
});

it("trace collection rejects malformed CDP envelopes without throwing", () => {
  const trace = collectReviewTrace();
  for (const event of [null, undefined, "unsafe", {}, { value: null }, { value: "unsafe" }]) {
    expect(() => trace.collect(event)).not.toThrow();
  }
  trace.collect({ value: [{ name: "Layout", ph: "X", pid: 1, tid: 2, ts: 1000, dur: 100 }] });
  expect(trace.snapshot().traceEvents).toHaveLength(1);
});
