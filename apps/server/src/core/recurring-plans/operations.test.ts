import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { BigDecimal, DateTime, Effect, Exit, Option, Schema } from "effect";
import {
  InvalidRecurringEdit,
  type RecurringDocument,
  type RecurringEdit,
  type RecurringFilters,
  RecurringFulfillment,
  type RecurringMatchFact,
  RecurringPlanId,
  RecurringPlanInput,
} from "./contract";
import {
  applyRecurringEdit,
  emptyRecurringDocument,
  filterRecurring,
  projectDates,
  projectRecurringMonth,
  proposeRecurringMatches,
  readRecurringOccurrence,
  summarizeRecurring,
  validAssociation,
  validRecurringFulfillment,
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

it("keeps same-date exceptions and payments separate for different plans", () => {
  const otherId = RecurringPlanId.make("20000000-0000-4000-8000-000000000012");
  const created = command(createdPlan(), { kind: "create", id: otherId, plan: monthly });
  const moved = command(created, {
    kind: "edit",
    planId,
    date: "2026-01-31",
    scope: "once",
    plan: { ...monthly, firstDate: "2026-02-02" },
  });
  const paid = command(moved, {
    kind: "fulfill",
    fulfillment: Schema.decodeSync(RecurringFulfillment)({
      id: "20000000-0000-4000-8000-000000000014",
      planId: otherId,
      date: "2026-01-31",
      actualDate: "2026-01-31",
      settled: true,
      money: { amount: "120", currency: "COP" },
    }),
  });
  const now = DateTime.makeUnsafe("2026-02-04T12:00:00Z");
  const january = projectRecurringMonth({ document: paid, month: "2026-01", now });
  expect(january.map((item) => [item.planId, item.expectedDate, item.status])).toEqual([
    [otherId, "2026-01-31", "completed"],
  ]);
  const february = projectRecurringMonth({ document: paid, month: "2026-02", now });
  expect(february.map((item) => [item.planId, item.expectedDate, item.status])).toEqual([
    [planId, "2026-02-02", "unconfirmed"],
    [planId, "2026-02-28", "upcoming"],
    [otherId, "2026-02-28", "upcoming"],
  ]);
  expect(february.every((item) => item.fulfillments.length === 0)).toBe(true);
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

it.each(["pause", "stop"] as const)(
  "%s suppresses a future occurrence restored after skipping",
  (action) => {
    const skipped = command(createdPlan(), {
      kind: "skip",
      planId,
      date: "2026-01-31",
      skipped: true,
    });
    const restored = command(skipped, { kind: "skip", planId, date: "2026-01-31", skipped: false });
    const inactive = command(restored, { kind: "lifecycle", planId, date: "2026-01-15", action });
    expect(
      projectRecurringMonth({
        document: inactive,
        month: "2026-01",
        now: DateTime.makeUnsafe("2026-01-15T12:00:00Z"),
      })
    ).toEqual([]);
  }
);

it.each(["pause", "stop"] as const)(
  "%s uses the displaced expected date rather than the occurrence identity",
  (action) => {
    for (const [identity, expected, visible] of [
      ["2026-01-31", "2026-01-14", true],
      ["2026-01-10", "2026-01-31", false],
    ] as const) {
      const created = command(emptyRecurringDocument(), {
        kind: "create",
        id: planId,
        plan: { ...monthly, firstDate: identity },
      });
      const edited = command(created, {
        kind: "edit",
        planId,
        date: identity,
        scope: "once",
        plan: { ...monthly, firstDate: expected },
      });
      const inactive = command(edited, { kind: "lifecycle", planId, date: "2026-01-15", action });
      const items = projectRecurringMonth({
        document: inactive,
        month: "2026-01",
        now: DateTime.makeUnsafe("2026-01-15T12:00:00Z"),
      });
      expect(items.map((item) => item.expectedDate)).toEqual(visible ? [expected] : []);
      if (visible) expect(items[0]?.status).toBe("unconfirmed");
    }
  }
);

it.each(["pause", "stop"] as const)(
  "%s suppresses an edited future expectation while preserving its recorded fulfillment",
  (action) => {
    const edited = command(createdPlan(), {
      kind: "edit",
      planId,
      date: "2026-01-31",
      scope: "once",
      plan: { ...monthly, name: "Excepción futura" },
    });
    const inactive = command(edited, { kind: "lifecycle", planId, date: "2026-01-15", action });
    const projection = { month: "2026-01", now: DateTime.makeUnsafe("2026-01-15T12:00:00Z") };
    expect(projectRecurringMonth({ document: inactive, ...projection })).toEqual([]);
    const paid = command(edited, {
      kind: "fulfill",
      fulfillment: Schema.decodeSync(RecurringFulfillment)({
        id: "20000000-0000-4000-8000-000000000015",
        planId,
        date: "2026-01-31",
        actualDate: "2026-01-14",
        settled: true,
        money: { amount: "100", currency: "COP" },
      }),
    });
    const paidInactive = command(paid, { kind: "lifecycle", planId, date: "2026-01-15", action });
    const items = projectRecurringMonth({ document: paidInactive, ...projection });
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("completed");
    expect(items[0]?.plan.name).toBe("Excepción futura");
  }
);

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

it("includes both calendar bounds and ends a schedule on its explicit last date", () => {
  for (const frequency of ["weekly", "fortnightly", "monthly"] as const) {
    const plan = { ...monthly, firstDate: "2026-01-01", endDate: "2026-01-01", frequency };
    expect(projectDates({ plan, from: "2026-01-01", through: "2026-12-31" })).toEqual([
      "2026-01-01",
    ]);
    expect(projectDates({ plan, from: "2026-01-02", through: "2026-12-31" })).toEqual([]);
  }
  expect(
    projectDates({
      plan: { ...monthly, frequency: "weekly", firstDate: "2026-01-01" },
      from: "2026-01-09",
      through: "2026-01-22",
    })
  ).toEqual(["2026-01-15", "2026-01-22"]);
  expect(
    projectDates({
      plan: { ...monthly, frequency: "twice-monthly", monthDays: [31, "last"] },
      from: "2026-02-01",
      through: "2026-02-28",
    })
  ).toEqual(["2026-02-28"]);
});

it("reads only existing occurrences for the requested plan and retains a displaced occurrence identity", () => {
  const document = createdPlan();
  expect(
    Option.isNone(readRecurringOccurrence({ document, planId: "missing", date: "2026-01-31" }))
  ).toBe(true);
  expect(Option.isNone(readRecurringOccurrence({ document, planId, date: "2026-01-30" }))).toBe(
    true
  );
  const item = Option.getOrThrow(readRecurringOccurrence({ document, planId, date: "2026-01-31" }));
  expect(item).toMatchObject({
    planId,
    date: "2026-01-31",
    expectedDate: "2026-01-31",
    status: "upcoming",
    fulfillments: [],
  });
  const moved = command(document, {
    kind: "edit",
    planId,
    date: "2026-01-31",
    scope: "once",
    plan: { ...monthly, firstDate: "2026-02-02" },
  });
  expect(
    Option.getOrThrow(readRecurringOccurrence({ document: moved, planId, date: "2026-01-31" }))
      .expectedDate
  ).toBe("2026-02-02");
});

const fixedPlan = Schema.decodeSync(RecurringPlanInput)({
  ...monthly,
  amountMode: "fixed",
  counterparty: "Café Central",
  money: { amount: "100", currency: "COP" },
});
const associatedFact: RecurringMatchFact = {
  id: "20000000-0000-4000-8000-000000000020",
  money: { amount: BigDecimal.make(100n, 0), currency: "COP" },
  date: "2026-01-31",
  direction: "outflow",
  counterparty: "  CAFE\u0301   CENTRAL  ",
  categoryId: "category",
};
const associatedMark = Schema.decodeSync(RecurringFulfillment)({
  id: "20000000-0000-4000-8000-000000000021",
  planId,
  date: "2026-01-31",
  actualDate: "2026-01-31",
  money: { amount: "100", currency: "COP" },
  settled: true,
  transactionId: associatedFact.id,
});

it("revalidates every retained financial fact and applies exact matching only to automatic associations", () => {
  expect(
    validRecurringFulfillment({ mark: associatedMark, fact: associatedFact, plan: fixedPlan })
  ).toBe(true);
  for (const fact of [
    { ...associatedFact, id: "another" },
    { ...associatedFact, money: { ...associatedFact.money, currency: "USD" as const } },
    { ...associatedFact, money: { ...associatedFact.money, amount: BigDecimal.make(99n, 0) } },
    { ...associatedFact, date: "2026-01-30" },
    { ...associatedFact, direction: "inflow" as const },
  ]) {
    expect(validRecurringFulfillment({ mark: associatedMark, fact, plan: fixedPlan })).toBe(false);
  }
  const automatic = { ...associatedMark, automatic: true };
  expect(
    validRecurringFulfillment({ mark: automatic, fact: associatedFact, plan: fixedPlan })
  ).toBe(true);
  for (const plan of [
    { ...monthly },
    { ...fixedPlan, accountId: "account" },
    { ...fixedPlan, counterparty: undefined },
    { ...fixedPlan, counterparty: "Other" },
    { ...fixedPlan, money: { amount: BigDecimal.make(99n, 0), currency: "COP" as const } },
  ]) {
    expect(validRecurringFulfillment({ mark: automatic, fact: associatedFact, plan })).toBe(false);
    expect(validRecurringFulfillment({ mark: associatedMark, fact: associatedFact, plan })).toBe(
      true
    );
  }
  expect(
    validRecurringFulfillment({
      mark: automatic,
      fact: { ...associatedFact, counterparty: undefined },
      plan: fixedPlan,
    })
  ).toBe(false);
  for (const kind of ["income", "expense", "transfer"] as const) {
    expect(validAssociation({ plan: { ...fixedPlan, kind }, fact: associatedFact })).toBe(
      kind !== "income"
    );
    expect(
      validAssociation({
        plan: { ...fixedPlan, kind },
        fact: { ...associatedFact, direction: "inflow" },
      })
    ).toBe(kind === "income");
  }
  expect(validAssociation({ plan: { ...fixedPlan, currency: "USD" }, fact: associatedFact })).toBe(
    false
  );
});

it("filters recurring occurrences by every supplied criterion with case-insensitive search", () => {
  const document = command(emptyRecurringDocument(), {
    kind: "create",
    id: planId,
    plan: {
      ...fixedPlan,
      categoryId: "20000000-0000-4000-8000-000000000022",
      accountId: "20000000-0000-4000-8000-000000000023",
    },
  });
  const items = projectRecurringMonth({
    document,
    month: "2026-01",
    now: DateTime.makeUnsafe("2026-01-01"),
  });
  expect(filterRecurring({ items, filters: {} })).toEqual(items);
  const filters: RecurringFilters = {
    search: "ARRIENDO",
    kind: "expense",
    frequency: "monthly",
    currency: "COP",
    categoryId: "20000000-0000-4000-8000-000000000022",
    accountId: "20000000-0000-4000-8000-000000000023",
    status: "upcoming",
  };
  expect(filterRecurring({ items, filters })).toEqual(items);
  for (const mismatch of [
    { search: "absent" },
    { kind: "income" },
    { frequency: "weekly" },
    { currency: "USD" },
    { categoryId: "other" },
    { accountId: "other" },
    { status: "completed" },
  ] as const) {
    expect(filterRecurring({ items, filters: { ...filters, ...mismatch } })).toEqual([]);
  }
});

it("sums actual, remaining, estimated and unknown amounts separately for each kind and Currency", () => {
  let document = command(emptyRecurringDocument(), { kind: "create", id: planId, plan: fixedPlan });
  document = command(document, {
    kind: "fulfill",
    fulfillment: {
      ...associatedMark,
      money: { amount: BigDecimal.make(40n, 0), currency: "COP" },
      settled: false,
    },
  });
  for (const [id, plan] of [
    ["20000000-0000-4000-8000-000000000024", { ...fixedPlan, amountMode: "estimated" as const }],
    ["20000000-0000-4000-8000-000000000025", monthly],
    [
      "20000000-0000-4000-8000-000000000026",
      {
        ...fixedPlan,
        kind: "income" as const,
        currency: "USD" as const,
        money: { amount: BigDecimal.make(100n, 0), currency: "USD" as const },
      },
    ],
  ] as const) {
    document = command(document, { kind: "create", id: RecurringPlanId.make(id), plan });
  }
  const summary = summarizeRecurring(
    projectRecurringMonth({ document, month: "2026-01", now: DateTime.makeUnsafe("2026-02-01") })
  );
  expect(
    summary.map((group) => ({
      kind: group.kind,
      currency: group.currency,
      completed: BigDecimal.format(group.completed.amount),
      remaining: BigDecimal.format(group.remaining.amount),
      estimated: BigDecimal.format(group.estimated.amount),
      unknown: group.unknown,
    }))
  ).toEqual([
    {
      kind: "expense",
      currency: "COP",
      completed: "40",
      remaining: "160",
      estimated: "100",
      unknown: 1,
    },
    {
      kind: "income",
      currency: "USD",
      completed: "0",
      remaining: "100",
      estimated: "0",
      unknown: 0,
    },
  ]);
});

const rejects = (
  document: RecurringDocument,
  edit: RecurringEdit,
  expectedRevision = document.revision
): void => {
  assert.deepStrictEqual(
    Effect.runSyncExit(applyRecurringEdit({ document, command: { expectedRevision, edit } })),
    Exit.fail(
      InvalidRecurringEdit.make({
        message: "Actualiza los recurrentes y revisa los datos antes de guardar.",
      })
    )
  );
};

it("rejects stale revisions, duplicate plans and lifecycle transitions without an eligible plan", () => {
  const document = createdPlan();
  const create: RecurringEdit = { kind: "create", id: planId, plan: monthly };
  rejects(document, create, 0);
  rejects(document, create);
  for (const action of ["pause", "resume", "stop"] as const) {
    rejects(document, {
      kind: "lifecycle",
      planId: RecurringPlanId.make("20000000-0000-4000-8000-000000000099"),
      date: "2026-01-31",
      action,
    });
  }
  rejects(document, { kind: "lifecycle", planId, date: "2026-01-31", action: "resume" });
  const paused = command(document, {
    kind: "lifecycle",
    planId,
    date: "2026-02-01",
    action: "pause",
  });
  rejects(paused, { kind: "lifecycle", planId, date: "2026-02-02", action: "pause" });
  rejects(paused, { kind: "lifecycle", planId, date: "2026-01-31", action: "resume" });
  const resumed = command(paused, {
    kind: "lifecycle",
    planId,
    date: "2026-02-01",
    action: "resume",
  });
  expect(resumed.plans[0]?.pauses).toEqual([{ from: "2026-02-01", through: "2026-02-01" }]);
  const stopped = command(resumed, {
    kind: "lifecycle",
    planId,
    date: "2026-03-01",
    action: "stop",
  });
  for (const action of ["pause", "resume", "stop"] as const) {
    rejects(stopped, { kind: "lifecycle", planId, date: "2026-03-01", action });
  }
  expect(
    projectRecurringMonth({
      document: stopped,
      month: "2026-03",
      now: DateTime.makeUnsafe("2026-03-01"),
    })
  ).toEqual([]);
});

it("updates one suggestion disposition without altering other decisions and can restore it", () => {
  const first = "20000000-0000-4000-8000-000000000030";
  const second = "20000000-0000-4000-8000-000000000031";
  const created = command(emptyRecurringDocument(), {
    kind: "create",
    id: planId,
    plan: monthly,
    seriesId: first,
  });
  expect(created.suggestions).toEqual([{ seriesId: first, disposition: "linked", planId }]);
  const dismissed = command(created, { kind: "suggestion", seriesId: second, action: "dismiss" });
  const redismissed = command(dismissed, {
    kind: "suggestion",
    seriesId: first,
    action: "dismiss",
  });
  expect(redismissed.suggestions).toEqual([
    { seriesId: second, disposition: "dismissed" },
    { seriesId: first, disposition: "dismissed" },
  ]);
  const restored = command(redismissed, { kind: "suggestion", seriesId: first, action: "restore" });
  expect(restored.suggestions).toEqual([{ seriesId: second, disposition: "dismissed" }]);
  rejects(restored, { kind: "suggestion", seriesId: first, action: "link" });
  const linked = command(restored, {
    kind: "suggestion",
    seriesId: second,
    action: "link",
    planId,
  });
  expect(linked.suggestions).toEqual([{ seriesId: second, disposition: "linked", planId }]);
});

it("replaces only a fulfillment for the same occurrence and reserves each associated Transaction once", () => {
  const created = command(emptyRecurringDocument(), {
    kind: "create",
    id: planId,
    plan: fixedPlan,
  });
  const paid = command(created, { kind: "fulfill", fulfillment: associatedMark });
  expect(
    projectRecurringMonth({
      document: paid,
      month: "2026-01",
      now: DateTime.makeUnsafe("2026-02-01"),
    })[0]?.remaining
  ).toEqual({ amount: BigDecimal.make(0n, 0), currency: "COP" });
  rejects(paid, { kind: "fulfill", fulfillment: associatedMark });
  rejects(paid, {
    kind: "fulfill",
    fulfillment: { ...associatedMark, id: "20000000-0000-4000-8000-000000000032" },
  });
  rejects(paid, { kind: "fulfill", replaces: "missing", fulfillment: associatedMark });
  rejects(paid, {
    kind: "fulfill",
    replaces: associatedMark.id,
    fulfillment: { ...associatedMark, date: "2026-02-28" },
  });
  rejects(paid, { kind: "edit", scope: "once", planId, date: "2026-01-31", plan: monthly });
  rejects(paid, { kind: "skip", planId, date: "2026-01-31", skipped: true });
  const replacement = {
    ...associatedMark,
    id: "20000000-0000-4000-8000-000000000032",
    money: { amount: BigDecimal.make(120n, 0), currency: "COP" as const },
  };
  const replaced = command(paid, {
    kind: "fulfill",
    replaces: associatedMark.id,
    fulfillment: replacement,
  });
  expect(replaced.fulfillments).toEqual([replacement]);
  const reversed = command(replaced, { kind: "reverse", fulfillmentId: replacement.id });
  expect(reversed.fulfillments).toEqual([]);
  expect(reversed.excludedTransactionIds).toEqual([associatedFact.id]);
  const again = command(reversed, { kind: "reverse", fulfillmentId: associatedFact.id });
  expect(again.excludedTransactionIds).toEqual([associatedFact.id]);
});

it("preserves completed future facts across forward edits and only changes the selected plan", () => {
  const created = command(emptyRecurringDocument(), {
    kind: "create",
    id: planId,
    plan: fixedPlan,
  });
  const secondId = RecurringPlanId.make("20000000-0000-4000-8000-000000000040");
  const two = command(created, { kind: "create", id: secondId, plan: monthly });
  const paid = command(two, {
    kind: "fulfill",
    fulfillment: { ...associatedMark, date: "2026-02-28" },
  });
  const changed = command(paid, {
    kind: "edit",
    scope: "forward",
    planId,
    date: "2026-02-01",
    plan: { ...fixedPlan, name: "Nuevo", firstDate: "2026-02-15" },
  });
  const items = projectRecurringMonth({
    document: changed,
    month: "2026-02",
    now: DateTime.makeUnsafe("2026-03-01T12:00:00Z"),
  });
  expect(
    items.map((item) => [item.planId, item.expectedDate, item.plan.name, item.status])
  ).toEqual([
    [planId, "2026-02-15", "Nuevo", "unconfirmed"],
    [planId, "2026-02-28", "Arriendo", "completed"],
    [secondId, "2026-02-28", "Arriendo", "unconfirmed"],
  ]);
  expect(changed.plans[1]).toEqual(two.plans[1]);
  expect(changed.revision).toBe(4);
});

it("never offers excluded, already allocated, ambiguous or partially recorded associations", () => {
  const document = command(emptyRecurringDocument(), {
    kind: "create",
    id: planId,
    plan: fixedPlan,
  });
  const items = projectRecurringMonth({
    document,
    month: "2026-01",
    now: DateTime.makeUnsafe("2026-01-01T12:00:00Z"),
  });
  expect(proposeRecurringMatches({ document, items, facts: [associatedFact] })).toHaveLength(1);
  for (const date of ["2026-01-28", "2026-02-03"]) {
    expect(
      proposeRecurringMatches({ document, items, facts: [{ ...associatedFact, date }] })
    ).toHaveLength(1);
  }
  for (const fact of [
    { ...associatedFact, date: "2026-01-27" },
    { ...associatedFact, direction: "inflow" as const },
    { ...associatedFact, money: { ...associatedFact.money, currency: "USD" as const } },
  ]) {
    expect(proposeRecurringMatches({ document, items, facts: [fact] })).toEqual([]);
  }
  expect(
    proposeRecurringMatches({
      document: { ...document, excludedTransactionIds: [associatedFact.id] },
      items,
      facts: [associatedFact],
    })
  ).toEqual([]);
  expect(
    proposeRecurringMatches({
      document: { ...document, fulfillments: [associatedMark] },
      items,
      facts: [associatedFact],
    })
  ).toEqual([]);
  for (const status of ["completed", "skipped", "partial"] as const) {
    expect(
      proposeRecurringMatches({
        document,
        items: items.map((item) => ({
          ...item,
          status,
          fulfillments: status === "partial" ? [associatedMark] : [],
        })),
        facts: [associatedFact],
      })
    ).toEqual([]);
  }
  const secondId = RecurringPlanId.make("20000000-0000-4000-8000-000000000050");
  expect(
    proposeRecurringMatches({
      document,
      items: [...items, ...items.map((item) => ({ ...item, planId: secondId }))],
      facts: [associatedFact],
    })
  ).toEqual([]);
});

it("starts a sparse calendar range at the next anchored quarterly or fortnightly occurrence", () => {
  expect(
    projectDates({
      plan: { ...monthly, frequency: "quarterly" },
      from: "2026-04-01",
      through: "2027-02-01",
    })
  ).toEqual(["2026-04-30", "2026-07-31", "2026-10-31", "2027-01-31"]);
  expect(
    projectDates({
      plan: { ...monthly, frequency: "fortnightly", firstDate: "2026-01-01" },
      from: "2026-02-01",
      through: "2026-02-28",
    })
  ).toEqual(["2026-02-12", "2026-02-26"]);
});

it("selects the new plan at the exact forward revision boundary and keeps the prior month intact", () => {
  const changed = command(createdPlan(), {
    kind: "edit",
    scope: "forward",
    planId,
    date: "2026-02-28",
    plan: { ...monthly, firstDate: "2026-02-28", name: "Nuevo" },
  });
  for (const [month, date, name] of [
    ["2026-01", "2026-01-31", "Arriendo"],
    ["2026-02", "2026-02-28", "Nuevo"],
    ["2026-03", "2026-03-28", "Nuevo"],
  ] as const) {
    const items = projectRecurringMonth({
      document: changed,
      month,
      now: DateTime.makeUnsafe("2026-04-01T12:00:00Z"),
    });
    expect(items.map((item) => [item.date, item.plan.name])).toEqual([[date, name]]);
  }
});

it("keeps separate pause intervals and applies exact stop and resume dates to occurrences", () => {
  let document = createdPlan();
  for (const [date, action] of [
    ["2026-01-31", "pause"],
    ["2026-02-28", "resume"],
    ["2026-03-31", "pause"],
    ["2026-04-30", "resume"],
  ] as const) {
    document = command(document, { kind: "lifecycle", planId, date, action });
  }
  expect(document.plans[0]?.pauses).toEqual([
    { from: "2026-01-31", through: "2026-02-28" },
    { from: "2026-03-31", through: "2026-04-30" },
  ]);
  for (const [month, expected] of [
    ["2026-01", []],
    ["2026-02", ["2026-02-28"]],
    ["2026-03", []],
    ["2026-04", ["2026-04-30"]],
  ] as const) {
    expect(
      projectRecurringMonth({
        document,
        month,
        now: DateTime.makeUnsafe("2026-05-01T12:00:00Z"),
      }).map((item) => item.date)
    ).toEqual(expected);
  }
  const stopped = command(document, {
    kind: "lifecycle",
    planId,
    date: "2026-05-31",
    action: "stop",
  });
  expect(
    projectRecurringMonth({
      document: stopped,
      month: "2026-05",
      now: DateTime.makeUnsafe("2026-05-01T12:00:00Z"),
    })
  ).toEqual([]);
});

it("completes exact fixed payments automatically while estimated and unknown values need explicit settlement", () => {
  for (const [plan, amount, settled, status, remaining] of [
    [fixedPlan, 100n, false, "completed", "0"],
    [fixedPlan, 120n, false, "completed", "0"],
    [{ ...fixedPlan, amountMode: "estimated" }, 120n, false, "partial", "0"],
    [monthly, 40n, false, "partial", undefined],
    [monthly, 40n, true, "completed", undefined],
  ] as const) {
    const created = command(emptyRecurringDocument(), { kind: "create", id: planId, plan });
    const paid = command(created, {
      kind: "fulfill",
      fulfillment: {
        ...associatedMark,
        money: { amount: BigDecimal.make(amount, 0), currency: "COP" },
        settled,
      },
    });
    const items = projectRecurringMonth({
      document: paid,
      month: "2026-01",
      now: DateTime.makeUnsafe("2026-02-01T12:00:00Z"),
    });
    expect(items[0]?.status).toBe(status);
    expect(
      items[0]?.remaining === undefined ? undefined : BigDecimal.format(items[0].remaining.amount)
    ).toBe(remaining);
    expect(summarizeRecurring(items)[0]?.unknown).toBe(
      plan.amountMode === "unknown" && !settled ? 1 : 0
    );
  }
});

it("does not invent another plan's occurrences from retained exceptions or fulfillments", () => {
  const secondId = RecurringPlanId.make("20000000-0000-4000-8000-000000000060");
  const two = command(createdPlan(), {
    kind: "create",
    id: secondId,
    plan: { ...monthly, firstDate: "2026-01-10" },
  });
  const moved = command(two, {
    kind: "edit",
    scope: "once",
    planId,
    date: "2026-01-31",
    plan: { ...monthly, firstDate: "2026-02-02" },
  });
  expect(
    Option.isNone(
      readRecurringOccurrence({ document: moved, planId: secondId, date: "2026-01-31" })
    )
  ).toBe(true);
  expect(
    projectRecurringMonth({
      document: moved,
      month: "2026-01",
      now: DateTime.makeUnsafe("2026-02-01T12:00:00Z"),
    }).map((item) => [item.planId, item.date])
  ).toEqual([[secondId, "2026-01-10"]]);
  const paid = command(two, { kind: "fulfill", fulfillment: associatedMark });
  expect(
    Option.isNone(readRecurringOccurrence({ document: paid, planId: secondId, date: "2026-01-31" }))
  ).toBe(true);
  expect(
    Option.getOrThrow(readRecurringOccurrence({ document: paid, planId, date: "2026-01-31" }))
      .status
  ).toBe("completed");
});

it("replaces one exception while retaining other exceptions and keeps displacement when skipping and restoring", () => {
  const first = command(createdPlan(), {
    kind: "edit",
    scope: "once",
    planId,
    date: "2026-01-31",
    plan: { ...monthly, firstDate: "2026-02-02" },
  });
  const second = command(first, {
    kind: "edit",
    scope: "once",
    planId,
    date: "2026-02-28",
    plan: { ...monthly, firstDate: "2026-03-02" },
  });
  const changed = command(second, {
    kind: "edit",
    scope: "once",
    planId,
    date: "2026-01-31",
    plan: { ...monthly, firstDate: "2026-02-03" },
  });
  expect(changed.exceptions).toHaveLength(2);
  const skipped = command(changed, { kind: "skip", planId, date: "2026-01-31", skipped: true });
  const restored = command(skipped, { kind: "skip", planId, date: "2026-01-31", skipped: false });
  const project = { month: "2026-02", now: DateTime.makeUnsafe("2026-02-01T12:00:00Z") };
  expect(
    projectRecurringMonth({ document: skipped, ...project }).map((item) => [
      item.expectedDate,
      item.status,
    ])
  ).toEqual([["2026-02-03", "skipped"]]);
  expect(
    projectRecurringMonth({ document: restored, ...project }).map((item) => [
      item.expectedDate,
      item.status,
    ])
  ).toEqual([["2026-02-03", "upcoming"]]);
});

it("rejects duplicate fulfillment identities across occurrences and association over an existing manual mark", () => {
  const { transactionId: _, ...manual } = associatedMark;
  const paid = command(createdPlan(), { kind: "fulfill", fulfillment: manual });
  rejects(paid, { kind: "fulfill", fulfillment: { ...manual, date: "2026-02-28" } });
  rejects(paid, {
    kind: "fulfill",
    fulfillment: { ...associatedMark, id: "20000000-0000-4000-8000-000000000061" },
  });
  const second = {
    ...associatedMark,
    id: "20000000-0000-4000-8000-000000000062",
    date: "2026-02-28",
  };
  const both = command(paid, { kind: "fulfill", fulfillment: second });
  const reversed = command(both, { kind: "reverse", fulfillmentId: manual.id });
  expect(reversed.fulfillments).toEqual([second]);
  expect(reversed.excludedTransactionIds).toEqual([manual.id]);
});

it("sorts user-selected twice-monthly days before returning the projected calendar", () => {
  expect(
    projectDates({
      plan: { ...monthly, frequency: "twice-monthly", monthDays: ["last", 15] },
      from: "2026-02-01",
      through: "2026-02-28",
    })
  ).toEqual(["2026-02-15", "2026-02-28"]);
});

it("keeps independent matches for different occurrences of one weekly plan", () => {
  const document = command(emptyRecurringDocument(), {
    kind: "create",
    id: planId,
    plan: { ...fixedPlan, frequency: "weekly", firstDate: "2026-01-01" },
  });
  const items = projectRecurringMonth({
    document,
    month: "2026-01",
    now: DateTime.makeUnsafe("2026-01-01T12:00:00Z"),
  });
  const first = { ...associatedFact, date: "2026-01-01" };
  const second = {
    ...associatedFact,
    id: "20000000-0000-4000-8000-000000000070",
    date: "2026-01-08",
  };
  expect(
    proposeRecurringMatches({ document, items, facts: [first, second] }).map((pair) => [
      pair.item.date,
      pair.fact.id,
    ])
  ).toEqual([
    ["2026-01-01", first.id],
    ["2026-01-08", second.id],
  ]);
});

it("keeps same-day associations for different plans and refuses a retained mark in another Currency", () => {
  const first = command(emptyRecurringDocument(), { kind: "create", id: planId, plan: fixedPlan });
  const secondId = RecurringPlanId.make("20000000-0000-4000-8000-000000000071");
  const document = command(first, {
    kind: "create",
    id: secondId,
    plan: { ...fixedPlan, counterparty: "Otro" },
  });
  const items = projectRecurringMonth({
    document,
    month: "2026-01",
    now: DateTime.makeUnsafe("2026-01-01T12:00:00Z"),
  });
  const other = {
    ...associatedFact,
    id: "20000000-0000-4000-8000-000000000072",
    counterparty: "Otro",
  };
  expect(
    proposeRecurringMatches({ document, items, facts: [associatedFact, other] }).map((pair) => [
      pair.item.planId,
      pair.fact.id,
    ])
  ).toEqual([
    [planId, associatedFact.id],
    [secondId, other.id],
  ]);
  expect(
    validRecurringFulfillment({
      mark: { ...associatedMark, money: { ...associatedMark.money, currency: "USD" } },
      fact: associatedFact,
      plan: fixedPlan,
    })
  ).toBe(false);
});

it("refuses a stale revision for an otherwise valid transition and refuses payment against a skipped occurrence", () => {
  const document = createdPlan();
  rejects(document, { kind: "lifecycle", planId, date: "2026-02-01", action: "pause" }, 0);
  const skipped = command(document, { kind: "skip", planId, date: "2026-01-31", skipped: true });
  rejects(skipped, { kind: "fulfill", fulfillment: associatedMark });
});

it("freezes a completed occurrence when a forward edit starts on that exact occurrence", () => {
  const paid = command(
    command(emptyRecurringDocument(), { kind: "create", id: planId, plan: fixedPlan }),
    { kind: "fulfill", fulfillment: associatedMark }
  );
  const changed = command(paid, {
    kind: "edit",
    planId,
    scope: "forward",
    date: "2026-01-31",
    plan: { ...fixedPlan, name: "Nuevo" },
  });
  expect(
    Option.getOrThrow(readRecurringOccurrence({ document: changed, planId, date: "2026-01-31" }))
      .plan.name
  ).toBe("Arriendo");
  expect(
    Option.getOrThrow(readRecurringOccurrence({ document: changed, planId, date: "2026-02-28" }))
      .plan.name
  ).toBe("Nuevo");
});

it("reads retained paid dates after their generated schedule is replaced", () => {
  const paid = command(createdPlan(), { kind: "fulfill", fulfillment: associatedMark });
  const changed = command(paid, {
    kind: "edit",
    planId,
    scope: "forward",
    date: "2026-01-01",
    plan: { ...monthly, firstDate: "2026-01-15" },
  });
  const retained = Option.getOrThrow(
    readRecurringOccurrence({ document: changed, planId, date: "2026-01-31" })
  );
  expect(retained.fulfillments).toEqual([associatedMark]);
  expect(retained.expectedDate).toBe("2026-01-31");
  expect(retained.status).toBe("completed");
  expect(
    Option.isNone(readRecurringOccurrence({ document: changed, planId, date: "2026-01-30" }))
  ).toBe(true);
});

it("does not automatically associate estimated Money even when the current estimate exactly matches a Transaction", () => {
  expect(
    validRecurringFulfillment({
      plan: { ...fixedPlan, amountMode: "estimated" },
      fact: associatedFact,
      mark: { ...associatedMark, automatic: true },
    })
  ).toBe(false);
});
