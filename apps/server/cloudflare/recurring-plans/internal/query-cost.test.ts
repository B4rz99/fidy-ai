import { DateTime, Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { RecurringDocument } from "../../../src/core/recurring-plans/contract";
import {
  projectRecurringMonth,
  recurringMatchCandidates,
  uniqueRecurringMatches,
} from "../../../src/core/recurring-plans/operations";
import { Transaction } from "../../../src/core/transactions/contract";
import { planningFact } from "./facts";
import { automaticMatches, workspaceValue } from "./query";
import { RecurringWorkspaceQuery } from "../../../src/shell/recurring-plans/contract";
import {
  installTestSchema,
  isolatedTestDatabases,
  observeRetentionCost,
} from "../../d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

it.each(["none", "own", "missing", "foreign"] as const)(
  "reads preferences, matching ranges and %s linked facts in one native round trip",
  (link) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* Effect.tryPromise(() => installTestSchema({ db }));
        const userId = "10000000-0000-4000-8000-000000000001";
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)"
            )
            .bind(userId)
            .run()
        );
        const linkedId = "81000000-0000-4000-8000-000000000001";
        if (link === "own" || link === "foreign") {
          const owner = link === "own" ? userId : "10000000-0000-4000-8000-000000000002";
          if (link === "foreign") {
            yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)"
                )
                .bind(owner)
                .run()
            );
          }
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms) VALUES(?,?,'1000','COP','outflow','Landlord','10000000-0000-4000-8000-000000000001',1791644400000,1791644400000)"
              )
              .bind(linkedId, owner)
              .run()
          );
        }
        const document = yield* Schema.decodeEffect(RecurringDocument)({
          revision: 0,
          exceptions: [],
          fulfillments:
            link === "none"
              ? []
              : [
                  {
                    id: "90000000-0000-4000-8000-000000000001",
                    planId: "40000000-0000-4000-8000-000000000001",
                    date: "2026-10-10",
                    actualDate: "2026-10-10",
                    money: { amount: "1000", currency: "COP" },
                    settled: true,
                    transactionId: linkedId,
                  },
                ],
          excludedTransactionIds: [],
          suggestions: [],
          plans: [
            {
              id: "40000000-0000-4000-8000-000000000001",
              pauses: [],
              revisions: [
                {
                  from: "2026-01-01",
                  plan: {
                    name: "Rent",
                    kind: "expense",
                    currency: "COP",
                    amountMode: "fixed",
                    money: { amount: "1000", currency: "COP" },
                    frequency: "monthly",
                    firstDate: "2026-01-10",
                    timeZone: "America/Bogota",
                    counterparty: "Landlord",
                  },
                },
              ],
            },
          ],
        });
        const query = yield* Schema.decodeEffect(RecurringWorkspaceQuery)({
          month: "2026-10",
        });
        const observed = observeRetentionCost(db);
        const result = yield* workspaceValue({ db: observed.database, userId, document, query });
        expect(result.matchesComplete).toBe(true);
        expect(result.invalidFulfillmentIds).toEqual(
          link === "missing" || link === "foreign" ? ["90000000-0000-4000-8000-000000000001"] : []
        );
        expect(result.occurrences).toHaveLength(1);
        expect(result.previous).toHaveLength(1);
        expect(
          observed
            .statements()
            .filter(({ sql }) => sql.includes("occurred_at_ms >= ? AND occurred_at_ms < ?"))
        ).toHaveLength(2);
        expect(observed.roundTrips()).toBe(1);
      })
    )
);

it("converts each transaction once per occurrence time zone while preserving match allocation", () => {
  const document = Schema.decodeUnknownSync(RecurringDocument)({
    revision: 0,
    exceptions: [],
    fulfillments: [],
    excludedTransactionIds: [],
    suggestions: [],
    plans: Array.from({ length: 100 }, (_, index) => ({
      id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      pauses: [],
      revisions: [
        {
          from: "2026-01-01",
          plan: {
            name: `Plan ${index}`,
            kind: "expense",
            currency: "COP",
            amountMode: "fixed",
            money: { amount: "1000", currency: "COP" },
            frequency: "monthly",
            firstDate: "2026-01-10",
            timeZone: index % 2 === 0 ? "America/Bogota" : "Pacific/Kiritimati",
            counterparty: `Party ${index}`,
          },
        },
      ],
    })),
  });
  const transaction = Schema.decodeSync(Transaction)({
    id: "81000000-0000-4000-8000-000000000001",
    money: { amount: "1000", currency: "COP" },
    direction: "outflow",
    counterparty: "Party 0",
    categoryId: "10000000-0000-4000-8000-000000000001",
    occurredAt: "2026-10-11T00:00:00.000Z",
    createdAt: "2026-10-11T00:00:00.000Z",
    revision: 0,
  });
  let conversions = 0;
  const transactions = [
    {
      ...transaction,
      get occurredAt(): Transaction["occurredAt"] {
        conversions++;
        return transaction.occurredAt;
      },
    },
  ];
  const items = projectRecurringMonth({
    document,
    month: "2026-10",
    now: DateTime.makeUnsafe("2026-10-29"),
  });
  const expected = uniqueRecurringMatches(
    items.flatMap((item) =>
      recurringMatchCandidates({
        document,
        items: [item],
        facts: transactions.map((entry) =>
          planningFact({ transaction: entry, timeZone: item.plan.timeZone })
        ),
      })
    )
  );
  conversions = 0;
  expect(automaticMatches({ document, items, transactions })).toEqual(expected);
  expect(expected).toHaveLength(1);
  expect(conversions).toBeLessThanOrEqual(2);
});
