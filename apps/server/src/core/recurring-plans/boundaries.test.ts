import { expect, it } from "vitest";
import { BigDecimal, DateTime, Effect, Exit, Option, Schema } from "effect";
import {
  RecurringDocument,
  type RecurringEdit,
  type RecurringFulfillment,
  type RecurringOccurrence,
  RecurringPlan,
  RecurringPlanId,
  RecurringPlanInput,
} from "./contract";
import {
  applyRecurringEdit,
  emptyRecurringDocument,
  projectDates,
  projectRecurringMonth,
  proposeRecurringMatches,
  readRecurringOccurrence,
  summarizeRecurring,
} from "./operations";

const id = (number: number): RecurringPlanId =>
  RecurringPlanId.make(`10000000-0000-4000-8000-${String(number).padStart(12, "0")}`);
const settings = Schema.decodeSync(RecurringPlanInput)({
  name: "Rent",
  kind: "expense",
  currency: "COP",
  amountMode: "fixed",
  money: { amount: "100", currency: "COP" },
  frequency: "monthly",
  firstDate: "2026-01-15",
  timeZone: "America/Bogota",
});
const tracked = (number: number, plan: RecurringPlanInput = settings): RecurringPlan => ({
  id: Schema.decodeSync(RecurringPlan.fields.id)(id(number)),
  revisions: [{ from: plan.firstDate, plan }],
  pauses: [],
});
const ledger = (...plans: ReadonlyArray<RecurringPlan>): RecurringDocument => ({
  ...emptyRecurringDocument(),
  plans,
});
const apply = (document: RecurringDocument, edit: RecurringEdit): RecurringDocument =>
  Effect.runSync(
    applyRecurringEdit({ document, command: { expectedRevision: document.revision, edit } })
  );
const project = (
  document: RecurringDocument,
  month = "2026-02"
): ReadonlyArray<RecurringOccurrence> =>
  projectRecurringMonth({ document, month, now: DateTime.makeUnsafe("2026-03-15T12:00:00Z") });
const mark = (number: number, planId: RecurringPlanId, date: string): RecurringFulfillment => ({
  id: id(number),
  planId,
  date,
  actualDate: date,
  money: { amount: BigDecimal.make(40n, 0), currency: settings.currency },
  settled: false,
});

it("preserves quarterly alignment when selecting months long after the first date", () => {
  expect(
    projectDates({
      plan: { ...settings, frequency: "quarterly" },
      from: "2026-04-01",
      through: "2026-04-30",
    })
  ).toEqual(["2026-04-15"]);
});
it("preserves weekly alignment when selecting a month long after the first date", () => {
  expect(
    projectDates({
      plan: { ...settings, frequency: "weekly" },
      from: "2026-04-01",
      through: "2026-04-30",
    })
  ).toEqual(["2026-04-02", "2026-04-09", "2026-04-16", "2026-04-23", "2026-04-30"]);
});
it("never projects a revision before its effective start", () => {
  const plan: RecurringPlan = {
    ...tracked(1, { ...settings, frequency: "weekly", firstDate: "2026-01-01" }),
    revisions: [
      {
        from: "2026-04-01",
        plan: { ...settings, frequency: "weekly" as const, firstDate: "2026-01-01" },
      },
    ],
  };
  expect(project(ledger(plan))).toEqual([]);
});
it("stops an old revision at the exact start of the next revision", () => {
  const first = { ...settings, firstDate: "2026-01-01" };
  const plan: RecurringPlan = {
    ...tracked(1, first),
    revisions: [
      { from: first.firstDate, plan: first },
      { from: "2026-02-01", plan: { ...first, frequency: "yearly" as const } },
    ],
  };
  expect(project(ledger(plan))).toEqual([]);
});
it("does not reuse an exception belonging to a different plan on the same date", () => {
  const document = {
    ...ledger(tracked(1), tracked(2)),
    exceptions: [
      {
        planId: id(2),
        date: "2026-01-15",
        skipped: false,
        replacement: { ...settings, name: "Moved rent", firstDate: "2026-01-01" },
      },
    ],
  };
  expect(
    project(document, "2026-01").map((item) => ({
      planId: item.planId,
      expectedDate: item.expectedDate,
    }))
  ).toEqual([
    { planId: id(2), expectedDate: "2026-01-01" },
    { planId: id(1), expectedDate: "2026-01-15" },
  ]);
});
it("excludes retained exceptions whose expected dates belong to the preceding month", () => {
  const document = {
    ...ledger(tracked(1)),
    exceptions: [{ planId: id(1), date: "2026-01-15", skipped: true }],
  };
  expect(project(document).map((item) => item.date)).toEqual(["2026-02-15"]);
});
it("keeps another plan's exception when unskipping the same calendar date", () => {
  const exception = {
    planId: id(2),
    date: "2026-01-15",
    skipped: false,
    replacement: { ...settings, name: "Other rent" },
  };
  const document = { ...ledger(tracked(1), tracked(2)), exceptions: [exception] };
  expect(
    apply(document, { kind: "skip", planId: id(1), date: exception.date, skipped: false })
      .exceptions
  ).toEqual([exception, { planId: id(1), date: exception.date, skipped: false }]);
});
it("refuses forward edits naming an absent plan even when another plan exists", () => {
  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        applyRecurringEdit({
          document: ledger(tracked(1)),
          command: {
            expectedRevision: 0,
            edit: {
              kind: "edit",
              planId: id(999),
              date: "2026-04-01",
              scope: "forward",
              plan: settings,
            },
          },
        })
      )
    )
  ).toBe(true);
});
it("freezes only the edited plan's completed future occurrences", () => {
  const original = ledger(tracked(1), tracked(2));
  const paid = apply(original, { kind: "fulfill", fulfillment: mark(10, id(1), "2026-04-15") });
  const changed = apply(paid, {
    kind: "edit",
    planId: id(2),
    date: "2026-01-15",
    scope: "forward",
    plan: { ...settings, name: "Changed rent" },
  });
  expect(changed.exceptions).toEqual([]);
  expect(changed.fulfillments).toEqual(paid.fulfillments);
});
it("leaves past completed occurrences unfrozen during a later forward edit", () => {
  const paid = apply(ledger(tracked(1)), {
    kind: "fulfill",
    fulfillment: mark(10, id(1), "2026-01-15"),
  });
  const changed = apply(paid, {
    kind: "edit",
    planId: id(1),
    date: "2026-03-15",
    scope: "forward",
    plan: { ...settings, name: "New rent" },
  });
  expect(changed.exceptions).toEqual([]);
  expect(changed.plans[0]?.revisions.map((revision) => revision.from)).toEqual([
    "2026-01-15",
    "2026-03-15",
  ]);
});
it("replaces every later revision when a forward edit precedes the initial effective date", () => {
  const document = ledger(tracked(1));
  const changed = apply(document, {
    kind: "edit",
    planId: id(1),
    date: "2026-01-01",
    scope: "forward",
    plan: { ...settings, name: "Replacement rent", firstDate: "2026-01-01" },
  });
  expect(changed.plans[0]?.revisions).toEqual([
    {
      from: "2026-01-01",
      plan: { ...settings, name: "Replacement rent", firstDate: "2026-01-01" },
    },
  ]);
});
it("replaces an equal-date revision without duplicating its original entry", () => {
  const changed = apply(ledger(tracked(1)), {
    kind: "edit",
    planId: id(1),
    date: "2026-01-15",
    scope: "forward",
    plan: { ...settings, name: "Replacement rent" },
  });
  expect(changed.plans[0]?.revisions).toEqual([
    { from: "2026-01-15", plan: { ...settings, name: "Replacement rent" } },
  ]);
});
it("permits two independent manual payment marks on the same occurrence", () => {
  const paid = apply(ledger(tracked(1)), {
    kind: "fulfill",
    fulfillment: mark(10, id(1), "2026-02-15"),
  });
  const twice = apply(paid, { kind: "fulfill", fulfillment: mark(11, id(1), "2026-02-15") });
  expect(Schema.encodeSync(RecurringDocument)(twice).fulfillments).toEqual(
    [10, 11].map((number) => ({
      id: id(number),
      planId: id(1),
      date: "2026-02-15",
      actualDate: "2026-02-15",
      money: { amount: "40", currency: "COP" },
      settled: false,
    }))
  );
});
it("permits independent Transaction associations for the same occurrence", () => {
  const first = { ...mark(10, id(1), "2026-02-15"), transactionId: id(110) };
  const second = { ...mark(11, id(1), "2026-02-15"), transactionId: id(111) };
  const paid = apply(ledger(tracked(1)), { kind: "fulfill", fulfillment: first });
  expect(apply(paid, { kind: "fulfill", fulfillment: second }).fulfillments).toEqual([
    first,
    second,
  ]);
});
it("links a suggestion to one selected plan in a collection", () => {
  const document = ledger(tracked(1), tracked(2));
  expect(
    apply(document, { kind: "suggestion", seriesId: id(55), action: "link", planId: id(1) })
      .suggestions
  ).toEqual([{ seriesId: id(55), disposition: "linked", planId: id(1) }]);
  for (const before of [emptyRecurringDocument(), document]) {
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          applyRecurringEdit({
            document: before,
            command: {
              expectedRevision: before.revision,
              edit: { kind: "suggestion", seriesId: id(55), action: "link", planId: id(999) },
            },
          })
        )
      )
    ).toBe(true);
  }
});
it("reversing an absent mark retains the current payment and excludes only the supplied identity", () => {
  const first = { ...mark(10, id(1), "2026-02-15"), transactionId: id(110) };
  const paid = apply(ledger(tracked(1)), { kind: "fulfill", fulfillment: first });
  const reversed = apply(paid, { kind: "reverse", fulfillmentId: id(999) });
  expect(reversed.fulfillments).toEqual([first]);
  expect(reversed.excludedTransactionIds).toEqual([id(999)]);
});

it("clips both partial months and an explicit end later than the requested window", () => {
  expect(
    projectDates({
      plan: { ...settings, endDate: "2026-06-30" },
      from: "2026-01-01",
      through: "2026-02-10",
    })
  ).toEqual(["2026-01-15"]);
  expect(
    projectDates({
      plan: { ...settings, frequency: "twice-monthly", monthDays: [1, 20] },
      from: "2026-01-01",
      through: "2026-01-31",
    })
  ).toEqual(["2026-01-20"]);
});
it("does not fold distinct Unicode Counterparty names while suggesting associations", () => {
  const document = ledger(tracked(1, { ...settings, counterparty: "Straße" }));
  const items = project(document);
  const fact = {
    id: id(110),
    money: settings.money,
    date: "2026-02-15",
    direction: "outflow",
    counterparty: "STRASSE",
    categoryId: id(11),
  };
  if (fact.money === undefined) throw new Error("Expected fixed Money");
  expect(
    proposeRecurringMatches({
      document,
      items,
      facts: [{ ...fact, money: fact.money, direction: "outflow" }],
    })
  ).toEqual([]);
});
it("retains an existing frozen exception without duplicating it on a forward edit", () => {
  const moved = apply(ledger(tracked(1)), {
    kind: "edit",
    scope: "once",
    planId: id(1),
    date: "2026-04-15",
    plan: { ...settings, name: "Frozen rent", firstDate: "2026-04-16" },
  });
  const paid = apply(moved, {
    kind: "fulfill",
    fulfillment: { ...mark(10, id(1), "2026-04-15"), actualDate: "2026-04-16" },
  });
  const changed = apply(paid, {
    kind: "edit",
    scope: "forward",
    planId: id(1),
    date: "2026-03-15",
    plan: { ...settings, name: "Changed rent" },
  });
  expect(changed.exceptions).toEqual(paid.exceptions);
});
it("replaces the selected payment even when another occurrence's mark precedes it", () => {
  const first = apply(ledger(tracked(1)), {
    kind: "fulfill",
    fulfillment: mark(10, id(1), "2026-01-15"),
  });
  const second = apply(first, { kind: "fulfill", fulfillment: mark(11, id(1), "2026-02-15") });
  const replaced = apply(second, {
    kind: "fulfill",
    replaces: id(11),
    fulfillment: mark(12, id(1), "2026-02-15"),
  });
  expect(replaced.fulfillments.map((entry) => entry.id)).toEqual([id(10), id(12)]);
});
it("returns a typed refusal when fulfilling an absent occurrence", () => {
  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        applyRecurringEdit({
          document: emptyRecurringDocument(),
          command: {
            expectedRevision: 0,
            edit: { kind: "fulfill", fulfillment: mark(10, id(1), "2026-01-15") },
          },
        })
      )
    )
  ).toBe(true);
});
it("reads an occurrence moved to an earlier date with its unconfirmed disposition", () => {
  const moved = apply(ledger(tracked(1)), {
    kind: "edit",
    scope: "once",
    planId: id(1),
    date: "2026-02-15",
    plan: { ...settings, firstDate: "2026-02-10" },
  });
  expect(
    Option.getOrThrow(
      readRecurringOccurrence({ document: moved, planId: id(1), date: "2026-02-15" })
    ).status
  ).toBe("unconfirmed");
});
it("treats an absent remaining estimate as unknown rather than inventing Money", () => {
  const item = Option.getOrThrow(Option.fromUndefinedOr(project(ledger(tracked(1)))[0]));
  const { remaining: _, ...withoutRemaining } = item;
  const totals = summarizeRecurring([
    { ...withoutRemaining, plan: { ...item.plan, amountMode: "estimated" } },
  ]);
  expect(
    totals.map((total) => ({
      amount: BigDecimal.format(total.estimated.amount),
      unknown: total.unknown,
    }))
  ).toEqual([{ amount: "0", unknown: 1 }]);
});

it("starts at the original anchor when the selected window begins in the preceding year", () => {
  expect(projectDates({ plan: settings, from: "2025-12-01", through: "2026-03-31" })).toEqual([
    "2026-01-15",
    "2026-02-15",
    "2026-03-15",
  ]);
});
