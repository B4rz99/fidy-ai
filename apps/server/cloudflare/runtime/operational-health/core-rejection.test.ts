import { Effect, Logger } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { makeCoreRejectionObserver } from "./runtime";

const burst = (
  observe: ReturnType<typeof makeCoreRejectionObserver>,
  { now, count }: Readonly<{ now: number; count: number }>
): Effect.Effect<void> =>
  Effect.forEach(
    Array.from({ length: count }),
    () => observe({ now, boundary: "http", status: 401 }),
    { discard: true }
  );

const warning = [
  {
    component: "core-rejections",
    operation: "coreRejectionBursts",
    state: "attention",
    message:
      "fidy.operational component=core-rejections operation=coreRejectionBursts state=attention severity=warning",
  },
];

it.effect("reports only concentrated Core refusal bursts", () =>
  Effect.gen(function* () {
    const logs: unknown[] = [];
    const loggers = new Set([Logger.make<unknown, void>(({ message }) => logs.push(message))]);
    const observe = makeCoreRejectionObserver();
    const now = 1_800_000;
    yield* burst(observe, { now, count: 99 }).pipe(
      Effect.provideService(Logger.CurrentLoggers, loggers)
    );
    yield* Effect.forEach([200, 400, 404, 422, 429, 500], (status) =>
      observe({ now, boundary: "http", status })
    ).pipe(Effect.provideService(Logger.CurrentLoggers, loggers));
    expect(logs).toEqual([]);
    yield* observe({ now, boundary: "http", status: 403 }).pipe(
      Effect.provideService(Logger.CurrentLoggers, loggers)
    );
    yield* burst(observe, { now, count: 1_000 }).pipe(
      Effect.provideService(Logger.CurrentLoggers, loggers)
    );
    expect(logs).toEqual([warning]);
  })
);

it.effect(
  "bounds burst logs across clock rollback and isolate restart and tolerates logging failure",
  () =>
    Effect.gen(function* () {
      const logs: unknown[] = [];
      const loggers = new Set([
        Logger.make<unknown, void>(({ message, cause, logLevel }) =>
          logs.push({ message, reasons: cause.reasons, logLevel })
        ),
      ]);
      const observe = makeCoreRejectionObserver();
      for (const [now, count] of [
        [1_800_000, 1_000],
        [1_740_000, 100],
        [1_860_000, 100],
      ] as const) {
        yield* burst(observe, { now, count }).pipe(
          Effect.provideService(Logger.CurrentLoggers, loggers)
        );
      }
      const expected = { message: warning, reasons: [], logLevel: "Warn" };
      expect(logs).toEqual([expected, expected]);
      yield* burst(makeCoreRejectionObserver(), { now: 1_920_000, count: 99 }).pipe(
        Effect.provideService(Logger.CurrentLoggers, loggers)
      );
      yield* burst(makeCoreRejectionObserver(), { now: 1_920_000, count: 99 }).pipe(
        Effect.provideService(Logger.CurrentLoggers, loggers)
      );
      expect(logs).toEqual([expected, expected]);
      const independent = makeCoreRejectionObserver();
      const brokenLogger = Logger.make(() => {
        throw new Error("private logging diagnostic");
      });
      yield* burst(independent, { now: 2_040_000, count: 100 }).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([brokenLogger]))
      );
      yield* burst(independent, { now: 2_100_000, count: 100 }).pipe(
        Effect.provideService(Logger.CurrentLoggers, loggers)
      );
      expect(logs).toEqual([expected, expected, expected]);
    })
);

it.effect("counts only admitted boundary statuses", () =>
  Effect.gen(function* () {
    const logs: unknown[] = [];
    const loggers = new Set([Logger.make<unknown, void>(({ message }) => logs.push(message))]);
    const now = 1_800_000;
    const callback = makeCoreRejectionObserver();
    const mcp = makeCoreRejectionObserver();
    const work = Effect.gen(function* () {
      for (let index = 0; index < 99; index += 1) {
        yield* callback({ now, boundary: "providerCallback", status: 400 });
        yield* mcp({ now, boundary: "mcp", status: 429 });
      }
      for (const status of [200, 303, 404, 429, 500]) {
        yield* callback({ now, boundary: "providerCallback", status });
      }
      for (const status of [200, 303, 500, 503]) {
        yield* mcp({ now, boundary: "mcp", status });
      }
      expect(logs).toEqual([]);
      yield* callback({ now, boundary: "providerCallback", status: 422 });
      yield* mcp({ now, boundary: "mcp", status: 403 });
    });
    yield* work.pipe(Effect.provideService(Logger.CurrentLoggers, loggers));
    expect(logs).toEqual([warning, warning]);
  })
);
