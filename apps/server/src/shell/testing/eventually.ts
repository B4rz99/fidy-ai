import { type Cause, type Duration, Effect, Function, Schedule } from "effect";

export type EventuallyPolicy = Readonly<{
  readonly timeout: Duration.Input;
  readonly interval: Duration.Input;
}>;

/**
 * Bounded live-system observation for PostgreSQL, HTTP, and multi-runtime state that cannot use
 * TestClock. It is a liveness guard only: tests must use Deferred or database locks to create the
 * condition being observed rather than relying on this polling cadence for coordination.
 */
export const eventually: {
  <A>(
    until: (value: A) => boolean,
    policy: EventuallyPolicy
  ): <E, R>(observation: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Cause.TimeoutError, R>;
  <A, E, R>(
    observation: Effect.Effect<A, E, R>,
    until: (value: A) => boolean,
    policy: EventuallyPolicy
  ): Effect.Effect<A, E | Cause.TimeoutError, R>;
} = Function.dual(
  3,
  <A, E, R>(
    observation: Effect.Effect<A, E, R>,
    until: (value: A) => boolean,
    policy: EventuallyPolicy
  ): Effect.Effect<A, E | Cause.TimeoutError, R> =>
    observation.pipe(
      Effect.repeat({ until, schedule: Schedule.spaced(policy.interval) }),
      Effect.timeout(policy.timeout)
    )
);
