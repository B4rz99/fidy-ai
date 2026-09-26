import { Effect, Exit, Option } from "effect";

/** An owner-prepared child of a guarded D1 publication. */
export type GuardedMutationChild<A, E> = Readonly<{
  statements: ReadonlyArray<D1PreparedStatement>;
  assertion: D1PreparedStatement;
  readCommitted: Effect.Effect<Option.Option<A>, E>;
}>;

export type GuardedMutationCommit<A> =
  | Readonly<{ _tag: "Committed"; values: ReadonlyArray<A> }>
  | Readonly<{ _tag: "Aborted"; cause: unknown }>
  | Readonly<{ _tag: "Unavailable" }>;

const readbackAttempts = 3;

/** Bounded readback: a transient failure or missing projection is retried after commit. */
const committedValue = <A, E>(
  readCommitted: Effect.Effect<Option.Option<A>, E>
): Effect.Effect<Option.Option<A>> =>
  Effect.gen(function* () {
    let read = yield* Effect.exit(readCommitted);
    for (
      let attempt = 1;
      attempt < readbackAttempts && (Exit.isFailure(read) || Option.isNone(read.value));
      attempt += 1
    ) {
      read = yield* Effect.exit(readCommitted);
    }
    return Exit.isFailure(read) ? Option.none<A>() : read.value;
  });

/**
 * Commit every guarded child in one D1 batch and stay with the operation until readback settles.
 * The caller owns classification of a failed unit and the response vocabulary; neither an R2
 * write nor a provider call belongs to this D1 commit. A failed or missing post-commit readback
 * is unavailable, never evidence that the D1 transaction rolled back.
 */
export const commitGuardedMutations = <A, E>({
  db,
  children,
}: Readonly<{
  db: D1Database;
  children: ReadonlyArray<GuardedMutationChild<A, E>>;
}>): Effect.Effect<GuardedMutationCommit<A>> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      if (children.length === 0) return { _tag: "Unavailable" } as const;
      const statements = children.flatMap((child) => [...child.statements, child.assertion]);
      const committed = yield* Effect.exit(Effect.tryPromise(() => db.batch(statements)));
      if (Exit.isFailure(committed)) return { _tag: "Aborted", cause: committed.cause } as const;
      const values: Array<A> = [];
      for (const child of children) {
        const value = yield* committedValue(child.readCommitted);
        if (Option.isNone(value)) return { _tag: "Unavailable" } as const;
        values.push(value.value);
      }
      return { _tag: "Committed", values } as const;
    })
  );
