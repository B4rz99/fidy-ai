import { Effect, Option } from "effect";
import type { CanonicalReadFinalization } from "../../canonical-admission/contract";
import { TransactionBoundaryFailure } from "../../canonical-work/contract";

const maximumFinalizationStatements = 8;

/** Only a complete final snapshot may commit its prepared Audit, standing and lease release. */
export const readFinalizedSnapshot = ({
  db,
  statements,
  finalization,
}: Readonly<{
  db: D1Database;
  statements: ReadonlyArray<D1PreparedStatement>;
  finalization: Option.Option<CanonicalReadFinalization>;
}>): Effect.Effect<ReadonlyArray<D1Result>, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const completion = yield* Option.match(finalization, {
      onNone: () =>
        Effect.succeed({
          statements: [],
          committed: (_rows: ReadonlyArray<D1Result>): void => {},
        }),
      onSome: (prepare) => prepare(),
    });
    if (completion.statements.length > maximumFinalizationStatements) {
      return yield* new TransactionBoundaryFailure({ cause: "Invalid read finalization" });
    }
    const rows = yield* Effect.tryPromise({
      try: () => db.batch([...statements, ...completion.statements]),
      catch: (cause) => new TransactionBoundaryFailure({ cause }),
    });
    completion.committed(rows.slice(statements.length));
    return rows.slice(0, statements.length);
  }).pipe(Effect.uninterruptible);
