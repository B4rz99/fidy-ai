import { DateTime, Schema } from "effect";
import { expect, it } from "vitest";
import { RecurringDocument } from "../../../src/core/recurring-plans/contract";
import {
  projectRecurringMonth,
  recurringMatchCandidates,
  uniqueRecurringMatches,
} from "../../../src/core/recurring-plans/operations";
import { Transaction } from "../../../src/core/transactions/contract";
import { planningFact } from "./facts";
import { automaticMatches } from "./query";

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
