import { Effect, Option, Schema } from "effect";
import { executeProCommand } from "../../src/shell/pro-grants/operations";
import { ProGrantFailure, type ProStatement } from "../../src/shell/pro-grants/contract";
import { ProGrantOperatorReply, ProGrantOperatorRequest } from "./contract";

/** Trusted operator commands only; SQL belongs to the existing Pro owner and target selection to native composition. */
export const executeOperatorPro = (
  input: Readonly<{ candidate: unknown; db: D1Database }>
): Effect.Effect<ProGrantOperatorReply> =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(ProGrantOperatorRequest, {
      onExcessProperty: "error",
    })(input.candidate).pipe(
      Effect.mapError(() => new ProGrantFailure({ reason: "invalid-input", candidates: [] }))
    );
    const entries = yield* executeProCommand({
      ...request,
      query: (statement) => runStatement({ db: input.db, statement }),
    });
    return yield* Schema.decodeEffect(ProGrantOperatorReply)({ kind: "success", entries });
  }).pipe(
    Effect.catchTag("ProGrantFailure", (failure) =>
      Schema.decodeEffect(ProGrantOperatorReply)({
        kind: "refused",
        reason: failure.reason,
        candidates: failure.candidates,
      })
    ),
    Effect.catchCause(() =>
      Effect.succeed({ kind: "refused", reason: "unavailable", candidates: [] } as const)
    )
  );

const runStatement = (
  input: Readonly<{ db: D1Database; statement: ProStatement }>
): Effect.Effect<ReadonlyArray<unknown>, ProGrantFailure> =>
  Effect.gen(function* () {
    const { statement, db } = input;
    const prepare = (
      part: Readonly<{ sql: string; params: ReadonlyArray<unknown> }>
    ): D1PreparedStatement => db.prepare(part.sql).bind(...part.params);
    const prefix = Option.toArray(statement.admission).map(prepare);
    const results = yield* Effect.tryPromise(() =>
      Promise.resolve(db.batch([...prefix, prepare(statement)]))
    );
    if (Option.isSome(statement.admission)) {
      const guard = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ allowed: Schema.Literals([0, 1]) })
      )(results[0]?.results[0]);
      if (guard.allowed !== 1) {
        return yield* new ProGrantFailure({ reason: "unavailable", candidates: [] });
      }
    }
    const result = results[prefix.length];
    if (result === undefined) {
      return yield* new ProGrantFailure({ reason: "unavailable", candidates: [] });
    }
    return result.results;
  }).pipe(Effect.mapError(() => new ProGrantFailure({ reason: "unavailable", candidates: [] })));
