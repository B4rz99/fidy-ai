import { Effect, type Exit } from "effect";
import { dual } from "effect/Function";

const interruptOnAbort = (signal: AbortSignal): Effect.Effect<never> =>
  Effect.callback<never>((resume) => {
    const interrupt = (): void => resume(Effect.interrupt);
    signal.addEventListener("abort", interrupt, { once: true });

    if (signal.aborted) interrupt();

    return Effect.sync(() => signal.removeEventListener("abort", interrupt));
  });

export const exitOnAbort: {
  (
    signal: AbortSignal
  ): <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<Exit.Exit<A, E>, never, R>;
  <A, E, R>(
    work: Effect.Effect<A, E, R>,
    signal: AbortSignal
  ): Effect.Effect<Exit.Exit<A, E>, never, R>;
} = dual(
  2,
  <A, E, R>(
    work: Effect.Effect<A, E, R>,
    signal: AbortSignal
  ): Effect.Effect<Exit.Exit<A, E>, never, R> =>
    Effect.suspend(() =>
      signal.aborted
        ? Effect.exit(Effect.interrupt)
        : Effect.raceFirst(work, interruptOnAbort(signal)).pipe(Effect.exit)
    )
);
