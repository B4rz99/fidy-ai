import { Context, Effect, Function, Option, Ref, type Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { CanonicalCaller } from "./authz";

type CanonicalPreTransactionPlan = Effect.Effect<
  ReadonlyArray<Schema.Json>,
  never,
  SqlClient.SqlClient
>;

type CanonicalPreTransactionPlanFactory = (caller: CanonicalCaller) => CanonicalPreTransactionPlan;

const plans = new WeakMap<object, CanonicalPreTransactionPlanFactory>();

/** Call-local preparation states consumed by workflows inside one canonical transaction. */
export const CanonicalPreTransactionStates = Context.Reference<
  Option.Option<Ref.Ref<ReadonlyArray<Schema.Json>>>
>("fidy/CanonicalPreTransactionStates", {
  defaultValue: () => Option.none(),
});

/** Attaches durable preparation to an Effect while preserving its public type. */
export const withCanonicalPreTransaction: {
  (
    prepare: CanonicalPreTransactionPlan
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    prepare: CanonicalPreTransactionPlan
  ): Effect.Effect<A, E, R>;
} = Function.dual(
  2,
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    prepare: CanonicalPreTransactionPlan
  ): Effect.Effect<A, E, R> => {
    plans.set(effect, () => prepare);
    return effect;
  }
);

const findCanonicalPreTransaction = (
  effect: object,
  caller: CanonicalCaller
): Option.Option<CanonicalPreTransactionPlan> =>
  Option.map(Option.fromNullishOr(plans.get(effect)), (prepare) => prepare(caller));

/** Preparation lookup and preservation for canonical execution adapters. */
export const CanonicalPreTransactions = {
  preserve<A, E, R>(
    effect: Effect.Effect<A, E, R>,
    source: (caller: CanonicalCaller) => object
  ): Effect.Effect<A, E, R> {
    plans.set(effect, (caller) =>
      Option.getOrElse(findCanonicalPreTransaction(source(caller), caller), () =>
        Effect.succeed([])
      )
    );
    return effect;
  },
  find(effect: object, caller: CanonicalCaller): Option.Option<CanonicalPreTransactionPlan> {
    return findCanonicalPreTransaction(effect, caller);
  },
} as const;

/** Takes the next prepared state, when execution entered through a canonical adapter. */
export const takeCanonicalPreTransactionState: Effect.Effect<
  Option.Option<Schema.Json>,
  never
> = Effect.gen(function* () {
  const states = yield* CanonicalPreTransactionStates;
  if (Option.isNone(states)) return Option.none();
  return yield* Ref.modify(states.value, (queued) => {
    const [head, ...tail] = queued;
    return [Option.fromUndefinedOr(head), tail];
  });
});
