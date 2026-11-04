import { Effect, Function, Schema } from "effect";
import { Money } from "../../src/core/_shared/money";

const Row = Schema.Struct({
  amount: Schema.String,
  currency: Money.fields.currency,
  category_id: Schema.String,
  direction: Schema.Literals(["inflow", "outflow"]),
  occurred_at_ms: Schema.Finite,
});
export const EngineDiagnosticPhase = Schema.Literals(["count", "plain", "effective", "decode"]);
type Phase = typeof EngineDiagnosticPhase.Type;
const columns = "amount,currency,category_id,direction,occurred_at_ms";

/** Streaming diagnostics only; each phase retains scalar counts, never a million-row array. */
type Input = Readonly<{ phase: Phase; userId: string }>;
export const diagnoseEngineCursor: {
  (input: Input): (sql: SqlStorage) => Response;
  (sql: SqlStorage, input: Input): Response;
} = Function.dual(2, (sql: SqlStorage, input: Input): Response => {
  const started = performance.now();
  Effect.runSync(Effect.logInfo("ENGINE_DIAGNOSTIC", { phase: input.phase, event: "entered" }));
  let rows = 0;
  if (input.phase === "count") {
    const row = sql
      .exec("SELECT COUNT(*) AS count FROM transactions WHERE user_id=?", input.userId)
      .one();
    rows = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(row).count;
  } else {
    const source = input.phase === "plain" ? "transactions" : "transaction_effective_source";
    const cursor = sql.exec(`SELECT ${columns} FROM ${source} WHERE user_id=?`, input.userId);
    for (const raw of cursor) {
      if (input.phase === "decode") {
        const row = Schema.decodeUnknownSync(Row)(raw);
        Schema.decodeSync(Schema.toCodecJson(Money))({
          amount: row.amount,
          currency: row.currency,
        });
      }
      rows++;
    }
  }
  const elapsed = performance.now() - started;
  Effect.runSync(
    Effect.logInfo("ENGINE_DIAGNOSTIC", { phase: input.phase, event: "completed", rows, elapsed })
  );
  return Response.json({ phase: input.phase, rows, elapsed });
});
