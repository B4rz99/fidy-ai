import { type Cause, Effect, type Scope } from "effect";
import { dual } from "effect/Function";

/** Interrupt only the body deadline; await its Scope's independently bounded finalizers. */
export const scopedJourney: {
  (
    budget: number
  ): <A, E, R>(
    work: Effect.Effect<A, E, R | Scope.Scope>
  ) => Effect.Effect<A, E | Cause.TimeoutError, Exclude<R, Scope.Scope>>;
  <A, E, R>(
    work: Effect.Effect<A, E, R | Scope.Scope>,
    budget: number
  ): Effect.Effect<A, E | Cause.TimeoutError, Exclude<R, Scope.Scope>>;
} = dual(
  2,
  <A, E, R>(
    work: Effect.Effect<A, E, R | Scope.Scope>,
    budget: number
  ): Effect.Effect<A, E | Cause.TimeoutError, Exclude<R, Scope.Scope>> =>
    work.pipe(Effect.timeout(budget), Effect.scoped)
);

/** Always attempt native deletion after logout, retaining either failure. Each gets its own Scope. */
export const cleanupJourney: {
  <E2>(
    cleanup: Effect.Effect<unknown, E2, Scope.Scope>,
    budget: number
  ): <E>(logout: Effect.Effect<unknown, E, Scope.Scope>) => Effect.Effect<void>;
  <E, E2>(
    logout: Effect.Effect<unknown, E, Scope.Scope>,
    cleanup: Effect.Effect<unknown, E2, Scope.Scope>,
    budget: number
  ): Effect.Effect<void>;
} = dual(
  3,
  <E, E2>(
    logout: Effect.Effect<unknown, E, Scope.Scope>,
    cleanup: Effect.Effect<unknown, E2, Scope.Scope>,
    budget: number
  ): Effect.Effect<void> =>
    logout.pipe(
      scopedJourney(budget),
      Effect.ensuring(cleanup.pipe(scopedJourney(budget), Effect.orDie)),
      Effect.asVoid,
      Effect.orDie
    )
);
