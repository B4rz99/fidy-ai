import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";

export type CanonicalQueryFailure<E> =
  | Readonly<{ _tag: "DeclaredFailure"; error: E }>
  | Readonly<{ _tag: "BoundaryFailure" }>
  | Readonly<{ _tag: "Interrupted" }>;

export type CanonicalQueryState<A, E> =
  | Readonly<{ _tag: "Initial"; waiting: boolean }>
  | Readonly<{
      _tag: "Ready";
      value: A;
      waiting: boolean;
      refreshFailure: Option.Option<CanonicalQueryFailure<E>>;
    }>
  | Readonly<{
      _tag: "Failure";
      failure: CanonicalQueryFailure<E>;
      waiting: boolean;
    }>;

const classifyFailure = <A, E>(result: AsyncResult.Failure<A, E>): CanonicalQueryFailure<E> => {
  if (Cause.hasInterruptsOnly(result.cause)) return { _tag: "Interrupted" };
  if (Cause.hasDies(result.cause) || Cause.hasInterrupts(result.cause)) {
    return { _tag: "BoundaryFailure" };
  }
  const error: Option.Option<E> = Cause.findErrorOption(result.cause);
  return Option.match(error, {
    onNone: () => ({ _tag: "BoundaryFailure" }),
    onSome: (error) => ({ _tag: "DeclaredFailure", error }),
  });
};

export const presentCanonicalQuery = <A, E>(
  result: AsyncResult.AsyncResult<A, E>
): CanonicalQueryState<A, E> =>
  AsyncResult.match(result, {
    onInitial: (initial) => ({ _tag: "Initial", waiting: initial.waiting }),
    onSuccess: (success) => ({
      _tag: "Ready",
      value: success.value,
      waiting: success.waiting,
      refreshFailure: Option.none(),
    }),
    onFailure: (failure) => {
      const classified = classifyFailure(failure);
      return Option.match(failure.previousSuccess, {
        onNone: () => ({
          _tag: "Failure" as const,
          failure: classified,
          waiting: failure.waiting,
        }),
        onSome: (previous) => ({
          _tag: "Ready" as const,
          value: previous.value,
          waiting: failure.waiting,
          refreshFailure: Option.some(classified),
        }),
      });
    },
  });
