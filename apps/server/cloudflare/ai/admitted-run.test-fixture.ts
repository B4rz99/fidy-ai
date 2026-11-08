import { Brand, Cause, Clock, DateTime, Effect } from "effect";
import type {
  HostedInitialTextContext,
  OpenAiTransportRun,
} from "../../src/shell/hosted-inference/contract";
import { IanaTimeZone } from "../../src/core/_shared/context";
import { makeAdmittedOpenAiRun as makeRun } from "./internal/admitted-run";

const initialContext = Brand.nominal<HostedInitialTextContext>();
export const hostedInitialTextContext = (text: string): HostedInitialTextContext =>
  initialContext({
    sections: [
      {
        _tag: "AssistantPolicy",
        channel: "web",
        user: {
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: IanaTimeZone.make("America/Bogota"),
        },
      },
      {
        _tag: "TurnStarted",
        timeZone: "America/Bogota",
        startedAt: DateTime.makeUnsafe("2026-09-22T12:00:00Z"),
      },
    ],
    activeRequest: { _tag: "Present", text },
  });

export const makeAdmittedOpenAiRun =
  ({
    run,
    nowEpochMs,
    ...admission
  }: Omit<Parameters<typeof makeRun>[0], "run"> &
    Readonly<{
      run: OpenAiTransportRun;
      nowEpochMs: () => number;
    }>): OpenAiTransportRun =>
  (model, request, options) =>
    Effect.runPromise(
      Clock.clockWith((clock) =>
        makeRun({
          ...admission,
          run: (model, request) => Effect.tryPromise((signal) => run(model, request, { signal })),
        })(model, request).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillis: Effect.sync(nowEpochMs),
            currentTimeMillisUnsafe: nowEpochMs,
            currentTimeNanos: Effect.sync(() => BigInt(nowEpochMs()) * 1_000_000n),
            currentTimeNanosUnsafe: () => BigInt(nowEpochMs()) * 1_000_000n,
            monotonicTimeNanos: clock.monotonicTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            sleep: (duration) => clock.sleep(duration),
          })
        )
      ),
      { signal: options.signal }
    ).catch((failure: unknown) =>
      Promise.reject(Cause.isUnknownError(failure) ? failure.cause : failure)
    );
