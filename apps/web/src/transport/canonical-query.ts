import { Cause, Data, Option } from "effect";
import { AsyncResult } from "effect/reactivity";

export type CanonicalQueryFailure<E> = Data.TaggedEnum<{
  DeclaredFailure: { readonly error: E };
  BoundaryFailure: {};
  Interrupted: {};
}>;

const failures = <E>(): Data.TaggedEnum.Constructor<CanonicalQueryFailure<E>> =>
  Data.taggedEnum<CanonicalQueryFailure<E>>();

export type CanonicalQueryState<A, E> = Data.TaggedEnum<{
  Initial: { readonly waiting: boolean };
  Ready: {
    readonly value: A;
    readonly waiting: boolean;
    readonly refreshFailure: Option.Option<CanonicalQueryFailure<E>>;
  };
  Failure: {
    readonly failure: CanonicalQueryFailure<E>;
    readonly waiting: boolean;
  };
}>;

const states = <A, E>(): Data.TaggedEnum.Constructor<CanonicalQueryState<A, E>> =>
  Data.taggedEnum<CanonicalQueryState<A, E>>();

const classifyFailure = <A, E>(result: AsyncResult.Failure<A, E>): CanonicalQueryFailure<E> => {
  const failure = failures<E>();

  if (Cause.hasInterruptsOnly(result.cause)) return failure.Interrupted();

  if (Cause.hasDies(result.cause) || Cause.hasInterrupts(result.cause)) {
    return failure.BoundaryFailure();
  }

  const error: Option.Option<E> = Cause.findErrorOption(result.cause);

  return Option.match(error, {
    onNone: () => failure.BoundaryFailure(),
    onSome: (error) => failure.DeclaredFailure({ error }),
  });
};

export const canonicalReady = <A, E>(value: A): CanonicalQueryState<A, E> =>
  states<A, E>().Ready({
    value,
    waiting: false,
    refreshFailure: Option.none<CanonicalQueryFailure<E>>(),
  });

export const presentCanonicalQuery = <A, E>(
  result: AsyncResult.AsyncResult<A, E>
): CanonicalQueryState<A, E> => {
  const state = states<A, E>();

  return AsyncResult.match(result, {
    onInitial: (initial): CanonicalQueryState<A, E> => state.Initial({ waiting: initial.waiting }),
    onSuccess: (success): CanonicalQueryState<A, E> =>
      state.Ready({
        value: success.value,
        waiting: success.waiting,
        refreshFailure: Option.none<CanonicalQueryFailure<E>>(),
      }),
    onFailure: (failure): CanonicalQueryState<A, E> => {
      const classified = classifyFailure(failure);

      return Option.match(failure.previousSuccess, {
        onNone: (): CanonicalQueryState<A, E> =>
          state.Failure({ failure: classified, waiting: failure.waiting }),
        onSome: (previous): CanonicalQueryState<A, E> =>
          state.Ready({
            value: previous.value,
            waiting: failure.waiting,
            refreshFailure: Option.some(classified),
          }),
      });
    },
  });
};
