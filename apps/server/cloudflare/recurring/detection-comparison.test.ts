import { digest, seedDetectionHistory, session, userId } from "./detection-comparison.test-fixture";
import { Config, Data, DateTime, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { RecurringProposal, RecurringSeriesPage } from "../../src/core/recurring/contract";
import { detectMonthlySeries, normalizeCounterparty } from "../../src/core/recurring/operations";
import { type RecurringTransactionFact } from "../../src/core/transactions/contract";
import { encodeMoneyAmount } from "../../src/core/_shared/money";
import { IanaTimeZone } from "../../src/core/_shared/context";
import { type BudgetContributionCursor } from "../transactions/contract";
import { findRecurringSnapshot, readRecurringFacts } from "../transactions/operations";
import { isolatedTestDatabases, observeRetentionCost } from "../d1-test-fixture";
import { evaluateRecurringSeries, listRecurringSeries } from "./operations";

class ComparisonFailed extends Data.TaggedError("ComparisonFailed")<{ message: string }> {}
const enabled =
  Effect.runSync(Config.String("INFRA_PERFORMANCE_MEASURE").pipe(Config.withDefault("0"))) === "1";
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const zone = IanaTimeZone.make("America/Bogota");
const scenarios = [
  { count: 6, groups: 1 },
  { count: 128, groups: 8 },
  { count: 2000, groups: 32 },
];
const Measurement = Schema.Struct({
  count: Schema.Int,
  groups: Schema.Int,
  mode: Schema.Literals(["scratch", "direct"]),
  steps: Schema.Int,
  maximumGroupFactsHeld: Schema.Int,
  rowsRead: Schema.Int,
  rowsWritten: Schema.Int,
  maximumAvoidableCursorRowsWritten: Schema.Int,
  maximumAvoidableCursorRowsRead: Schema.Int,
  statements: Schema.Int,
  elapsedMs: Schema.Finite,
});
const measurements: Array<typeof Measurement.Type> = [];
const key = (fact: RecurringTransactionFact): Option.Option<string> =>
  Option.map(
    fact.counterparty,
    (value) => fact.money.currency + "|" + normalizeCounterparty(value)
  );
type GroupSelection = {
  group: Option.Option<string>;
  facts: RecurringTransactionFact[];
  overflow: boolean;
};
const selectFact = (
  selection: GroupSelection,
  fact: RecurringTransactionFact,
  after: string
): void => {
  const candidate = key(fact);
  if (Option.isNone(candidate) || candidate.value <= after) return;
  if (Option.isNone(selection.group) || candidate.value < selection.group.value) {
    selection.group = candidate;
    selection.facts = [];
    selection.overflow = false;
  }
  if (candidate.value !== Option.getOrThrow(selection.group)) return;
  if (selection.facts.length === 512) {
    selection.overflow = true;
    return;
  }
  selection.facts.push(fact);
};
/** Measurement candidate: retain one complete group while traversing only Transactions' published pages. */
const nextDirectGroup = Effect.fn(function* (db: D1Database, revision: number, after: string) {
  let cursor: BudgetContributionCursor = { occurredAt: "", transactionId: "" };
  const selection: GroupSelection = { group: Option.none(), facts: [], overflow: false };
  let pages = 0;
  for (;;) {
    const page = Option.getOrThrow(yield* readRecurringFacts({ db, userId, revision, cursor }));
    pages++;
    for (const fact of page.facts) selectFact(selection, fact, after);
    if (page.complete) break;
    cursor = page.cursor;
  }
  if (selection.overflow) {
    return yield* new ComparisonFailed({
      message: "Direct group exceeds the unchanged 512-fact ceiling",
    });
  }
  return { ...selection, pages };
});
const direct = Effect.fn(function* (db: D1Database) {
  const snapshot = Option.getOrThrow(yield* findRecurringSnapshot({ db, userId }));
  let after = "";
  let steps = 0;
  let maximumGroupFactsHeld = 0;
  const proposals: RecurringProposal[] = [];
  for (;;) {
    const found = yield* nextDirectGroup(db, snapshot.revision, after);
    steps += found.pages;
    maximumGroupFactsHeld = Math.max(maximumGroupFactsHeld, found.facts.length);
    if (Option.isNone(found.group)) break;
    proposals.push(...detectMonthlySeries({ facts: found.facts, timeZone: zone }));
    if (proposals.length > 128) {
      return yield* new ComparisonFailed({ message: "Direct proposal capacity" });
    }
    after = found.group.value;
  }
  return { proposals, steps, maximumGroupFactsHeld };
});
const proposalShape = (proposal: RecurringProposal): ReadonlyArray<string> => [
  proposal.counterparty,
  encodeMoneyAmount(proposal.money.amount),
  proposal.money.currency,
  DateTime.formatIso(proposal.firstOccurredAt),
  DateTime.formatIso(proposal.lastOccurredAt),
];
const read = Effect.fn(function* (db: D1Database) {
  const response = yield* listRecurringSeries({
    db,
    subject: { id: session, userId, digest },
    request: new Request("https://api.fidyapp.com/recurring-series"),
  });
  expect(response.status).toBe(200);
  return (yield* Schema.decodeUnknownEffect(
    Schema.toCodecJson(Schema.Struct({ data: RecurringSeriesPage }))
  )(yield* Effect.tryPromise(() => response.json()))).data;
});
const cursorSavings = (
  statements: ReadonlyArray<Readonly<{ sql: string; rowsRead: number; rowsWritten: number }>>
): Readonly<{
  maximumAvoidableCursorRowsRead: number;
  maximumAvoidableCursorRowsWritten: number;
}> => {
  const intermediate = statements
    .filter((statement) =>
      statement.sql.startsWith("UPDATE recurring_evaluation_records SET cursor_at")
    )
    .slice(0, -1);
  return {
    maximumAvoidableCursorRowsRead: intermediate.reduce(
      (total, statement) => total + statement.rowsRead,
      0
    ),
    maximumAvoidableCursorRowsWritten: intermediate.reduce(
      (total, statement) => total + statement.rowsWritten,
      0
    ),
  };
};
it.skipIf(!enabled).each(scenarios)(
  "compares equivalent detector results through bounded owner reads: %j",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* seedDetectionHistory(db, scenario);
        expect((yield* read(db)).evaluation.kind).toBe("not-evaluated");
        const scratch = observeRetentionCost(db);
        const start = performance.now();
        // Fixture cardinalities bound scan calls, group calls and the two phase transitions.
        const steps = Math.floor(scenario.count / 128) + 1 + scenario.groups + 2;
        let inspectionMs = 0;
        let staged: ReadonlyArray<string> = [];
        for (let index = 0; index < steps; index++) {
          if (index === steps - 1) {
            const inspectionStart = performance.now();
            staged = (yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ proposal_json: Schema.String }))
            )(
              (yield* Effect.tryPromise(() =>
                db
                  .prepare(
                    "SELECT proposal_json FROM recurring_evaluation_records WHERE kind='proposal' AND user_id=? ORDER BY id"
                  )
                  .bind(userId)
                  .all()
              )).results
            )).map((row) => row.proposal_json);
            inspectionMs += performance.now() - inspectionStart;
          }
          yield* evaluateRecurringSeries({ db: scratch.database, userId });
        }
        const elapsedMs = performance.now() - start - inspectionMs;
        const published = yield* read(db);
        expect(published.evaluation.kind).toBe("current");
        expect(published.series).toHaveLength(scenario.groups);
        measurements.push({
          ...scenario,
          mode: "scratch",
          steps,
          maximumGroupFactsHeld: Math.ceil(scenario.count / scenario.groups),
          ...scratch.cost(),
          ...cursorSavings(scratch.statements()),
          statements: scratch.statements().length,
          elapsedMs,
        });
        const observed = observeRetentionCost(db);
        const directStart = performance.now();
        const candidate = yield* direct(observed.database);
        measurements.push({
          ...scenario,
          mode: "direct",
          steps: candidate.steps,
          maximumGroupFactsHeld: candidate.maximumGroupFactsHeld,
          ...observed.cost(),
          maximumAvoidableCursorRowsWritten: 0,
          maximumAvoidableCursorRowsRead: 0,
          statements: observed.statements().length,
          elapsedMs: performance.now() - directStart,
        });
        const candidateSnapshots = yield* Effect.forEach(candidate.proposals, (proposal) =>
          Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(RecurringProposal)))(
            proposal
          )
        );
        expect(candidateSnapshots).toEqual(staged);
        expect(candidate.proposals.map(proposalShape)).toEqual(
          published.series.map((series) => [
            series.counterparty,
            encodeMoneyAmount(series.money.amount),
            series.money.currency,
            DateTime.formatIso(series.firstOccurredAt),
            DateTime.formatIso(series.lastOccurredAt),
          ])
        );
      })
    ),
  60000
);
afterAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (!enabled) return;
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Measurement)))(
        measurements
      );
      yield* Effect.tryPromise(() =>
        Bun.write(
          new URL(
            "../../../../docs/research/recurring-detector-measurements.json",
            import.meta.url
          ),
          encoded
        )
      );
    })
  )
);
