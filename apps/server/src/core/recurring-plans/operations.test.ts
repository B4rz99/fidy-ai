import { describe, expect, it } from "vitest";
import { BigDecimal, DateTime, Effect, Schema } from "effect";
import {
  type RecurringDocument,
  type RecurringEdit,
  RecurringFulfillment,
  RecurringPlanId,
  RecurringPlanInput,
} from "./contract";
import {
  applyRecurringEdit,
  emptyRecurringDocument,
  projectDates,
  projectRecurringMonth,
  proposeRecurringMatches,
  summarizeRecurring,
} from "./operations";

const monthly = Schema.decodeSync(RecurringPlanInput)({
  name: "Arriendo",
  kind: "expense",
  currency: "COP",
  amountMode: "unknown",
  frequency: "monthly",
  firstDate: "2026-01-31",
  timeZone: "America/Bogota",
});

describe("RecurringPlan calendar expectations", () => {
  it("clamps a January 31 anchor without permanently drifting after February", () => {
    expect(projectDates({ plan: monthly, from: "2026-02-01", through: "2026-04-30" })).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });
});

it("keeps fourteen-day and twice-monthly dates distinct, including leap month end", () => {
  const base = { ...monthly, firstDate: "2028-02-01" };
  expect(
    projectDates({
      plan: { ...base, frequency: "fortnightly" },
      from: "2028-02-01",
      through: "2028-03-15",
    })
  ).toEqual(["2028-02-01", "2028-02-15", "2028-02-29", "2028-03-14"]);
  expect(
    projectDates({
      plan: { ...base, frequency: "twice-monthly", monthDays: [15, "last"] },
      from: "2028-02-01",
      through: "2028-03-31",
    })
  ).toEqual(["2028-02-15", "2028-02-29", "2028-03-15", "2028-03-31"]);
});

it("tracks a partial payment without creating financial history and preserves it after a forward edit", () => {
  const planId = RecurringPlanId.make("20000000-0000-4000-8000-000000000001");
  const plan = Schema.decodeSync(Schema.toType(RecurringPlanInput))({
    ...monthly,
    amountMode: "fixed",
    money: { amount: BigDecimal.make(100n, 0), currency: "COP" },
  });
  const created = Effect.runSync(
    applyRecurringEdit({
      document: emptyRecurringDocument(),
      command: { expectedRevision: 0, edit: { kind: "create", id: planId, plan } },
    })
  );
  const paid = Effect.runSync(
    applyRecurringEdit({
      document: created,
      command: {
        expectedRevision: 1,
        edit: {
          kind: "fulfill",
          fulfillment: Schema.decodeSync(RecurringFulfillment)({
            id: "20000000-0000-4000-8000-000000000002",
            planId,
            date: "2026-01-31",
            actualDate: "2026-01-30",
            money: { amount: "40", currency: "COP" },
            settled: false,
          }),
        },
      },
    })
  );
  const changed = Effect.runSync(
    applyRecurringEdit({
      document: paid,
      command: {
        expectedRevision: 2,
        edit: {
          kind: "edit",
          planId,
          date: "2026-02-28",
          scope: "forward",
          plan: { ...plan, name: "Nuevo arriendo" },
        },
      },
    })
  );
  const january = projectRecurringMonth({
    document: changed,
    month: "2026-01",
    now: DateTime.makeUnsafe("2026-02-02T12:00:00Z"),
  });
  expect(january[0]?.status).toBe("partial");
  expect(january[0]?.plan.name).toBe("Arriendo");
  expect(january[0]?.remaining).toEqual({ amount: BigDecimal.make(60n, 0), currency: "COP" });
});

it.each([
  ["weekly", ["2028-02-29", "2028-03-07", "2028-03-14"]],
  ["quarterly", ["2028-02-29", "2028-05-29"]],
  ["half-yearly", ["2028-02-29", "2028-08-29"]],
  ["yearly", ["2028-02-29", "2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]],
] as const)("projects %s without inventing pre-start history", (frequency, expected) => {
  const limits = {
    weekly: "2028-03-14",
    quarterly: "2028-05-31",
    "half-yearly": "2028-08-31",
    yearly: "2032-02-29",
  };
  const through = limits[frequency];
  expect(
    projectDates({
      plan: { ...monthly, firstDate: "2028-02-29", frequency },
      from: "2027-01-01",
      through,
    })
  ).toEqual(expected);
});

const planId = RecurringPlanId.make("20000000-0000-4000-8000-000000000011");
const command = (document: RecurringDocument, edit: RecurringEdit): RecurringDocument =>
  Effect.runSync(
    applyRecurringEdit({ document, command: { expectedRevision: document.revision, edit } })
  );
const createdPlan = (): RecurringDocument =>
  command(emptyRecurringDocument(), {
    kind: "create",
    id: planId,
    plan: { ...monthly, firstDate: "2026-01-31" },
  });
it("retains unresolved earlier occurrences, excludes a paused interval and resumes on the original anchor", () => {
  const paused = command(createdPlan(), {
    kind: "lifecycle",
    planId,
    date: "2026-02-01",
    action: "pause",
  });
  const resumed = command(paused, {
    kind: "lifecycle",
    planId,
    date: "2026-04-01",
    action: "resume",
  });
  expect(
    projectRecurringMonth({
      document: resumed,
      month: "2026-02",
      now: DateTime.makeUnsafe("2026-04-01T12:00:00Z"),
    })
  ).toEqual([]);
  expect(
    projectRecurringMonth({
      document: resumed,
      month: "2026-04",
      now: DateTime.makeUnsafe("2026-04-01T12:00:00Z"),
    }).map((item) => item.date)
  ).toEqual(["2026-04-30"]);
  expect(
    projectRecurringMonth({
      document: resumed,
      month: "2026-01",
      now: DateTime.makeUnsafe("2026-04-01T12:00:00Z"),
    })[0]?.status
  ).toBe("unconfirmed");
});
it("keeps card payments out of expenses and unknown amounts out of known remaining Money", () => {
  const income = command(createdPlan(), {
    kind: "create",
    id: RecurringPlanId.make("20000000-0000-4000-8000-000000000012"),
    plan: { ...monthly, kind: "transfer", cardPayment: true },
  });
  const summary = summarizeRecurring(
    projectRecurringMonth({
      document: income,
      month: "2026-01",
      now: DateTime.makeUnsafe("2026-01-01T12:00:00Z"),
    })
  );
  expect(summary.map((group) => ({ kind: group.kind, unknown: group.unknown }))).toEqual([
    { kind: "expense", unknown: 1 },
    { kind: "transfer", unknown: 1 },
  ]);
});
it("requires an exact unique fixed amount within three days and never allocates a competing Transaction", () => {
  const fixed = command(emptyRecurringDocument(), {
    kind: "create",
    id: planId,
    plan: Schema.decodeSync(RecurringPlanInput)({
      ...monthly,
      amountMode: "fixed",
      counterparty: "Comercio",
      money: { amount: "100", currency: "COP" },
    }),
  });
  const items = projectRecurringMonth({
    document: fixed,
    month: "2026-01",
    now: DateTime.makeUnsafe("2026-02-01T12:00:00Z"),
  });
  const fact = {
    id: "20000000-0000-4000-8000-000000000013",
    money: { amount: BigDecimal.make(100n, 0), currency: "COP" as const },
    date: "2026-02-03",
    direction: "outflow" as const,
    counterparty: " comercio ",
    categoryId: "category",
  };
  expect(proposeRecurringMatches({ document: fixed, items, facts: [fact] })).toHaveLength(1);
  expect(
    proposeRecurringMatches({ document: fixed, items, facts: [{ ...fact, date: "2026-02-04" }] })
  ).toEqual([]);
  expect(
    proposeRecurringMatches({ document: fixed, items, facts: [fact, { ...fact, id: "another" }] })
  ).toEqual([]);
  expect(
    proposeRecurringMatches({
      document: fixed,
      items,
      facts: [{ ...fact, money: { amount: BigDecimal.make(99n, 0), currency: "COP" } }],
    })
  ).toEqual([]);
});

it("moves only one occurrence, keeps its identity, permits actual values above a fixed projection, and reverses the mark", () => {
  const changed = command(createdPlan(), {
    kind: "edit",
    planId,
    date: "2026-01-31",
    scope: "once",
    plan: { ...monthly, firstDate: "2026-02-02" },
  });
  const february = projectRecurringMonth({
    document: changed,
    month: "2026-02",
    now: DateTime.makeUnsafe("2026-02-01T12:00:00Z"),
  });
  expect(february.map((item) => item.expectedDate)).toEqual(["2026-02-02", "2026-02-28"]);
  const mark = Schema.decodeSync(RecurringFulfillment)({
    id: "20000000-0000-4000-8000-000000000014",
    planId,
    date: "2026-01-31",
    actualDate: "2026-02-03",
    settled: true,
    money: { amount: "120", currency: "COP" },
  });
  const paid = command(changed, { kind: "fulfill", fulfillment: mark });
  expect(
    projectRecurringMonth({
      document: paid,
      month: "2026-02",
      now: DateTime.makeUnsafe("2026-02-04T12:00:00Z"),
    })[0]?.status
  ).toBe("completed");
  const reversed = command(paid, { kind: "reverse", fulfillmentId: mark.id });
  expect(
    projectRecurringMonth({
      document: reversed,
      month: "2026-02",
      now: DateTime.makeUnsafe("2026-02-04T12:00:00Z"),
    })[0]?.status
  ).toBe("unconfirmed");
});
it("refuses fabricated occurrence dates and mixed-currency fulfillment", () => {
  const document = createdPlan();
  for (const edit of [
    { kind: "skip", planId, date: "2026-01-30", skipped: true },
    { kind: "edit", planId, date: "2026-01-30", scope: "once", plan: monthly },
    {
      kind: "fulfill",
      fulfillment: Schema.decodeSync(RecurringFulfillment)({
        id: "20000000-0000-4000-8000-000000000014",
        planId,
        date: "2026-01-31",
        actualDate: "2026-01-31",
        settled: true,
        money: { amount: "10", currency: "USD" },
      }),
    },
  ] as const) {
    expect(
      Effect.runSyncExit(applyRecurringEdit({ document, command: { expectedRevision: 1, edit } }))
        ._tag
    ).toBe("Failure");
  }
});
it("retains skipped disposition while excluding its Money from summaries", () => {
  const skipped = command(createdPlan(), {
    kind: "skip",
    planId,
    date: "2026-01-31",
    skipped: true,
  });
  const items = projectRecurringMonth({
    document: skipped,
    month: "2026-01",
    now: DateTime.makeUnsafe("2026-02-01T12:00:00Z"),
  });
  expect(items[0]?.status).toBe("skipped");
  expect(summarizeRecurring(items)).toEqual([]);
});

it.each(["once", "forward"] as const)(
  "uses the effective occurrence time zone after a %s edit near midnight",
  (scope) => {
    const initial = { ...monthly, firstDate: "2026-10-13" };
    const created = command(emptyRecurringDocument(), {
      kind: "create",
      id: planId,
      plan: initial,
    });
    const now = DateTime.makeUnsafe("2026-10-14T02:00:00Z");
    expect(projectRecurringMonth({ document: created, month: "2026-10", now })[0]?.status).toBe(
      "upcoming"
    );
    const changed = command(created, {
      kind: "edit",
      planId,
      date: "2026-10-13",
      scope,
      plan: {
        ...initial,
        timeZone: Schema.decodeSync(RecurringPlanInput.fields.timeZone)("Pacific/Kiritimati"),
      },
    });
    expect(projectRecurringMonth({ document: changed, month: "2026-10", now })[0]?.status).toBe(
      "unconfirmed"
    );
  }
);
