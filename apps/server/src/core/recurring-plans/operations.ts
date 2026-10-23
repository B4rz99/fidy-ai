import { BigDecimal, DateTime, Effect, Option, Schema } from "effect";
import type { ReadonlyMoney } from "~/core/_shared/money";
import {
  InvalidRecurringEdit,
  type RecurringCommand,
  RecurringDocument,
  type RecurringEdit,
  type RecurringFilters,
  type RecurringFulfillment,
  type RecurringMatch,
  type RecurringMatchFact,
  type RecurringOccurrence,
  type RecurringPlan,
  type RecurringPlanInput,
  type RecurringSummary,
} from "./contract";

const monthsPerYear = 12;
const daysPerWeek = 7;
const fortnight = 14;
const halfYear = 6;
const monthlyStep = { monthly: 1, quarterly: 3, "half-yearly": halfYear, yearly: monthsPerYear };
const dateAt = (year: number, month: number, day: number): string =>
  DateTime.formatIsoDateUtc(DateTime.makeUnsafe({ year, month, day }));
const lastDay = (year: number, month: number): number =>
  DateTime.toPartsUtc(
    DateTime.makeUnsafe({ year, month, day: 1 }).pipe(
      DateTime.add({ months: 1 }),
      DateTime.subtract({ days: 1 })
    )
  ).day;
const monthDates = (plan: RecurringPlanInput, offset: number): ReadonlyArray<string> => {
  const anchor = DateTime.toPartsUtc(DateTime.makeUnsafe(plan.firstDate));
  const target = DateTime.toPartsUtc(
    DateTime.makeUnsafe({ year: anchor.year, month: anchor.month, day: 1 }).pipe(
      DateTime.add({ months: offset })
    )
  );
  const end = lastDay(target.year, target.month);
  const days =
    plan.frequency === "twice-monthly" ? (plan.monthDays ?? [anchor.day, "last"]) : [anchor.day];
  return [
    ...new Set(
      days.map((day) =>
        dateAt(target.year, target.month, day === "last" ? end : Math.min(day, end))
      )
    ),
  ].sort();
};
const monthlyDates = ({
  plan,
  from,
  through,
  step,
}: Readonly<{
  plan: RecurringPlanInput;
  from: string;
  through: string;
  step: number;
}>): ReadonlyArray<string> => {
  const first = DateTime.toPartsUtc(DateTime.makeUnsafe(plan.firstDate));
  const end = DateTime.toPartsUtc(DateTime.makeUnsafe(through));
  const months = (end.year - first.year) * monthsPerYear + end.month - first.month;
  const dates: string[] = [];
  const start = DateTime.toPartsUtc(DateTime.makeUnsafe(from));
  const elapsed = (start.year - first.year) * monthsPerYear + start.month - first.month;
  const initialOffset = Math.max(0, Math.ceil(elapsed / step) * step);
  for (let offset = initialOffset; offset <= months; offset += step) {
    dates.push(...monthDates(plan, offset));
  }
  return dates.filter((date) => date >= plan.firstDate && date >= from && date <= through);
};
/** Preserve the original anchor when clamping short months. No implicit bank-day adjustment. */
export const projectDates = ({
  plan,
  from,
  through,
}: Readonly<{
  plan: RecurringPlanInput;
  from: string;
  through: string;
}>): ReadonlyArray<string> => {
  const end = plan.endDate !== undefined && plan.endDate < through ? plan.endDate : through;
  if (plan.frequency !== "weekly" && plan.frequency !== "fortnightly") {
    return monthlyDates({
      plan,
      from,
      through: end,
      step: plan.frequency === "twice-monthly" ? 1 : monthlyStep[plan.frequency],
    });
  }
  const step = plan.frequency === "weekly" ? daysPerWeek : fortnight;
  const dates: string[] = [];
  for (
    let date = firstWeeklyDate(plan.firstDate, from, step);
    date <= end;
    date = DateTime.formatIsoDateUtc(DateTime.add(DateTime.makeUnsafe(date), { days: step }))
  ) {
    dates.push(date);
  }
  return dates;
};

const firstWeeklyDate = (anchor: string, from: string, step: number): string => {
  const first = DateTime.makeUnsafe(anchor);
  const elapsed =
    (DateTime.toEpochMillis(DateTime.makeUnsafe(from)) - DateTime.toEpochMillis(first)) /
    millisecondsPerDay;
  return DateTime.formatIsoDateUtc(
    DateTime.add(first, { days: Math.max(0, Math.ceil(elapsed / step) * step) })
  );
};

export const planAt = ({
  plan,
  date,
}: Readonly<{ plan: RecurringPlan; date: string }>): RecurringPlanInput => {
  const revision = plan.revisions.findLast((entry) => entry.from <= date) ?? plan.revisions[0];
  return revision.plan;
};
const trackedOn = ({ plan, date }: Readonly<{ plan: RecurringPlan; date: string }>): boolean =>
  (plan.stoppedOn === undefined || date < plan.stoppedOn) &&
  !plan.pauses.some(
    (pause) => date >= pause.from && (pause.through === undefined || date < pause.through)
  );
const occurrenceAt = ({
  document,
  plan,
  date,
  today,
}: Readonly<{
  document: RecurringDocument;
  plan: RecurringPlan;
  date: string;
  today: (plan: RecurringPlanInput) => string;
}>): RecurringOccurrence => {
  const exception = document.exceptions.find(
    (entry) => entry.planId === plan.id && entry.date === date
  );
  const input = exception?.replacement ?? planAt({ plan, date });
  const fulfillments = document.fulfillments.filter(
    (entry) => entry.planId === plan.id && entry.date === date
  );
  const amount = fulfillments.reduce(
    (sum: ReadonlyMoney["amount"], entry) => BigDecimal.sum(sum, entry.money.amount),
    BigDecimal.make(0n, 0)
  );
  const completed = { amount, currency: input.currency };
  const settled = isSettled({ fulfillments, plan: input, amount: completed });
  const remaining = remainingMoney({ plan: input, settled, completed });
  const expectedDate = exception?.replacement?.firstDate ?? date;
  return {
    planId: plan.id,
    date,
    expectedDate,
    plan: input,
    completed,
    fulfillments,
    ...remaining,
    status: occurrenceStatus({
      skipped: exception?.skipped === true,
      settled,
      amount: completed,
      expectedDate,
      today: today(input),
    }),
  };
};
const isSettled = ({
  fulfillments,
  plan,
  amount,
}: Readonly<{
  fulfillments: RecurringOccurrence["fulfillments"];
  plan: RecurringPlanInput;
  amount: ReadonlyMoney;
}>): boolean => {
  if (fulfillments.some((entry) => entry.settled)) return true;
  return (
    plan.amountMode === "fixed" &&
    plan.money !== undefined &&
    BigDecimal.Order(amount.amount, plan.money.amount) >= 0
  );
};
const remainingMoney = ({
  plan,
  settled,
  completed,
}: Readonly<{ plan: RecurringPlanInput; settled: boolean; completed: ReadonlyMoney }>): Partial<
  Readonly<{ remaining: ReadonlyMoney }>
> => {
  if (plan.money === undefined) return {};
  const zero = BigDecimal.make(0n, 0);
  return {
    remaining: {
      currency: plan.currency,
      amount: settled
        ? zero
        : BigDecimal.max(zero, BigDecimal.subtract(plan.money.amount, completed.amount)),
    },
  };
};
const occurrenceStatus = ({
  skipped,
  settled,
  amount,
  expectedDate,
  today,
}: Readonly<{
  skipped: boolean;
  settled: boolean;
  amount: ReadonlyMoney;
  expectedDate: string;
  today: string;
}>): RecurringOccurrence["status"] => {
  if (skipped) return "skipped";
  if (settled) return "completed";
  if (!BigDecimal.isZero(amount.amount)) return "partial";
  return expectedDate < today ? "unconfirmed" : "upcoming";
};
const generatedDates = (
  plan: RecurringPlan,
  from: string,
  through: string
): ReadonlyArray<string> =>
  plan.revisions.flatMap((revision, index) =>
    projectDates({
      plan: revision.plan,
      from: revision.from > from ? revision.from : from,
      through,
    }).filter((date) => {
      const next = plan.revisions[index + 1];
      return (next === undefined || date < next.from) && trackedOn({ plan, date });
    })
  );
/** One complete month, plus displaced exceptions; completed records survive schedule and lifecycle changes. */
export const projectRecurringMonth = ({
  document,
  month,
  now,
}: Readonly<{
  document: RecurringDocument;
  month: string;
  now: DateTime.Utc;
}>): ReadonlyArray<RecurringOccurrence> => {
  const from = `${month}-01`;
  const through = DateTime.formatIsoDateUtc(
    DateTime.makeUnsafe(from).pipe(DateTime.add({ months: 1 }), DateTime.subtract({ days: 1 }))
  );
  return document.plans
    .flatMap((plan) => {
      const retained = [...document.exceptions, ...document.fulfillments]
        .filter((entry) => entry.planId === plan.id)
        .map((entry) => entry.date);
      const dates = new Set([...generatedDates(plan, from, through), ...retained]);
      return [...dates]
        .map((date) =>
          occurrenceAt({
            document,
            plan,
            date,
            today: (input) =>
              DateTime.formatIsoDate(DateTime.makeZonedUnsafe(now, { timeZone: input.timeZone })),
          })
        )
        .filter(
          (item) =>
            item.expectedDate >= from &&
            item.expectedDate <= through &&
            (item.fulfillments.length > 0 || trackedOn({ plan, date: item.expectedDate }))
        );
    })
    .sort(
      (left, right) =>
        left.expectedDate.localeCompare(right.expectedDate) ||
        left.planId.localeCompare(right.planId)
    );
};

export const readRecurringOccurrence = ({
  document,
  planId,
  date,
}: Readonly<{
  document: RecurringDocument;
  planId: string;
  date: string;
}>): Option.Option<RecurringOccurrence> => {
  const plan = document.plans.find((entry) => entry.id === planId);
  if (plan === undefined) return Option.none();
  const retained = [...document.exceptions, ...document.fulfillments].some(
    (entry) => entry.planId === planId && entry.date === date
  );
  return retained || generatedDates(plan, date, date).includes(date)
    ? Option.some(occurrenceAt({ document, plan, date, today: () => date }))
    : Option.none();
};

const millisecondsPerDay = 86_400_000;
const maximumDrift = 3;
const normalized = (value: string): string =>
  value
    .normalize("NFKC")
    .replaceAll(/\p{White_Space}+/gu, " ")
    .trim()
    .toLowerCase();
/** Manual association still requires the same effective identity, Currency and movement direction. */
export const validAssociation = ({
  plan,
  fact,
}: Readonly<{ plan: RecurringPlanInput; fact: RecurringMatchFact }>): boolean =>
  plan.currency === fact.money.currency &&
  (plan.kind === "income" ? fact.direction === "inflow" : fact.direction === "outflow");
const comparable = (plan: RecurringPlanInput, fact: RecurringMatchFact): boolean => {
  if (plan.amountMode !== "fixed" || plan.accountId !== undefined) return false;
  if (plan.counterparty === undefined || fact.counterparty === undefined) return false;
  if (normalized(plan.counterparty) !== normalized(fact.counterparty)) return false;
  return plan.money !== undefined && BigDecimal.equals(plan.money.amount, fact.money.amount);
};
/** Revalidate retained associations against effective facts and frozen occurrence settings. */
export const validRecurringFulfillment = ({
  mark,
  fact,
  plan,
}: Readonly<{
  mark: RecurringFulfillment;
  fact: RecurringMatchFact;
  plan: RecurringPlanInput;
}>): boolean =>
  fact.id === mark.transactionId &&
  fact.money.currency === mark.money.currency &&
  BigDecimal.equals(fact.money.amount, mark.money.amount) &&
  fact.date === mark.actualDate &&
  validAssociation({ plan, fact }) &&
  (mark.automatic !== true || comparable(plan, fact));
const qualifies = (item: RecurringOccurrence, fact: RecurringMatchFact): boolean => {
  if (item.status === "completed" || item.status === "skipped" || item.fulfillments.length > 0) {
    return false;
  }
  if (!comparable(item.plan, fact)) return false;
  const drift =
    Math.abs(
      DateTime.toEpochMillis(DateTime.makeUnsafe(item.expectedDate)) -
        DateTime.toEpochMillis(DateTime.makeUnsafe(fact.date))
    ) / millisecondsPerDay;
  return drift <= maximumDrift && validAssociation({ plan: item.plan, fact });
};
/** Return eligible exact pairs for explicit review or a one-to-one automatic projection. */
export const recurringMatchCandidates = ({
  document,
  items,
  facts,
}: Readonly<{
  document: RecurringDocument;
  items: ReadonlyArray<RecurringOccurrence>;
  facts: ReadonlyArray<RecurringMatchFact>;
}>): ReadonlyArray<Readonly<{ item: RecurringOccurrence; fact: RecurringMatchFact }>> => {
  const allocated = new Set([
    ...document.excludedTransactionIds,
    ...document.fulfillments.flatMap((entry) =>
      entry.transactionId === undefined ? [] : [entry.transactionId]
    ),
  ]);
  const pairs = items.flatMap((item) =>
    facts
      .filter((fact) => !allocated.has(fact.id) && qualifies(item, fact))
      .map((fact) => ({ item, fact }))
  );
  return pairs;
};
export const uniqueRecurringMatches = (
  pairs: ReadonlyArray<RecurringMatch>
): ReadonlyArray<RecurringMatch> =>
  pairs.filter(
    (pair) =>
      pairs.filter((entry) => entry.fact.id === pair.fact.id).length === 1 &&
      pairs.filter(
        (entry) => entry.item.planId === pair.item.planId && entry.item.date === pair.item.date
      ).length === 1
  );
/** Deterministic effective-fact associations. Recalculation follows corrections without a query-side write. */
export const proposeRecurringMatches = (
  input: Parameters<typeof recurringMatchCandidates>[0]
): ReadonlyArray<RecurringMatch> => uniqueRecurringMatches(recurringMatchCandidates(input));

export const filterRecurring = ({
  items,
  filters,
}: Readonly<{
  items: ReadonlyArray<RecurringOccurrence>;
  filters: RecurringFilters;
}>): ReadonlyArray<RecurringOccurrence> =>
  items.filter((item) =>
    Object.entries(filters).every(([key, value]: readonly [string, string]) => {
      if (key === "search") return item.plan.name.toLowerCase().includes(value.toLowerCase());
      if (key === "status") return item.status === value;
      if (key === "kind") return item.plan.kind === value;
      if (key === "frequency") return item.plan.frequency === value;
      if (key === "currency") return item.plan.currency === value;
      if (key === "categoryId") return item.plan.categoryId === value;
      if (key === "accountId") return item.plan.accountId === value;
      return true;
    })
  );
/** Complete filtered monthly items; earlier unresolved rows never contribute to this month's sums. */
export const summarizeRecurring = (
  items: ReadonlyArray<RecurringOccurrence>
): ReadonlyArray<RecurringSummary> => {
  const groups = new Map<string, RecurringSummary>();
  for (const item of items.filter((entry) => entry.status !== "skipped")) {
    const currency = item.plan.currency;
    const key = `${item.plan.kind}:${currency}`;
    const zero = { amount: BigDecimal.make(0n, 0), currency };
    const prior = groups.get(key) ?? {
      kind: item.plan.kind,
      currency,
      completed: zero,
      remaining: zero,
      estimated: zero,
      unknown: 0,
    };
    groups.set(key, {
      ...prior,
      completed: {
        currency,
        amount: BigDecimal.sum(prior.completed.amount, item.completed.amount),
      },
      remaining: {
        currency,
        amount: BigDecimal.sum(prior.remaining.amount, item.remaining?.amount ?? zero.amount),
      },
      estimated: { currency, amount: BigDecimal.sum(prior.estimated.amount, estimate(item)) },
      unknown: prior.unknown + unknownCount(item),
    });
  }
  return [...groups.values()];
};

const estimate = (item: RecurringOccurrence): ReadonlyMoney["amount"] =>
  item.plan.amountMode === "estimated"
    ? (item.remaining?.amount ?? BigDecimal.make(0n, 0))
    : BigDecimal.make(0n, 0);
const unknownCount = (item: RecurringOccurrence): number =>
  item.remaining === undefined && item.status !== "completed" ? 1 : 0;

export const emptyRecurringDocument = (): RecurringDocument => ({
  revision: 0,
  excludedTransactionIds: [],
  plans: [],
  exceptions: [],
  fulfillments: [],
  suggestions: [],
});
const invalid = (): InvalidRecurringEdit =>
  InvalidRecurringEdit.make({
    message: "Actualiza los recurrentes y revisa los datos antes de guardar.",
  });
const sameKey = (
  left: Readonly<{ planId: string; date: string }>,
  right: Readonly<{ planId: string; date: string }>
): boolean => left.planId === right.planId && left.date === right.date;
const withPlan = (document: RecurringDocument, plan: RecurringPlan): RecurringDocument => ({
  ...document,
  plans: document.plans.map((entry) => (entry.id === plan.id ? plan : entry)),
});
const scopedEdit = (
  document: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "edit" }>
): Option.Option<RecurringDocument> => {
  const plan = document.plans.find((entry) => entry.id === edit.planId);
  if (
    plan === undefined ||
    (edit.scope === "once" &&
      Option.isNone(readRecurringOccurrence({ document, planId: edit.planId, date: edit.date })))
  ) {
    return Option.none();
  }
  if (edit.scope === "once" && document.fulfillments.some((entry) => sameKey(entry, edit))) {
    return Option.none();
  }
  if (edit.scope === "once") {
    return Option.some({
      ...document,
      exceptions: [
        ...document.exceptions.filter((entry) => !sameKey(entry, edit)),
        { planId: edit.planId, date: edit.date, skipped: false, replacement: edit.plan },
      ],
    });
  }
  const frozen = document.fulfillments
    .filter((entry) => entry.planId === edit.planId && entry.date >= edit.date)
    .filter((entry) => !document.exceptions.some((exception) => sameKey(exception, entry)))
    .map((entry) => ({
      planId: entry.planId,
      date: entry.date,
      skipped: false,
      replacement: { ...planAt({ plan, date: entry.date }), firstDate: entry.date },
    }));
  const previous = plan.revisions.filter((entry) => entry.from < edit.date);
  const replacement = { from: edit.date, plan: edit.plan };
  const first = previous[0];
  const revisions: RecurringPlan["revisions"] =
    first === undefined ? [replacement] : [first, ...previous.slice(1), replacement];
  return Option.some({
    ...withPlan(document, { ...plan, revisions }),
    exceptions: [...document.exceptions, ...frozen],
  });
};
const lifecycle = (
  document: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "lifecycle" }>
): Option.Option<RecurringDocument> => {
  const plan = document.plans.find((entry) => entry.id === edit.planId);
  if (plan === undefined || plan.stoppedOn !== undefined) return Option.none();
  const open = plan.pauses.find((pause) => pause.through === undefined);
  if (edit.action === "stop") {
    return Option.some(withPlan(document, { ...plan, stoppedOn: edit.date }));
  }
  if (edit.action === "pause") {
    return open === undefined
      ? Option.some(withPlan(document, { ...plan, pauses: [...plan.pauses, { from: edit.date }] }))
      : Option.none();
  }
  if (open === undefined || edit.date < open.from) return Option.none();
  return Option.some(
    withPlan(document, {
      ...plan,
      pauses: plan.pauses.map((pause) =>
        pause === open ? { ...pause, through: edit.date } : pause
      ),
    })
  );
};
const validReplacement = (
  document: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "fulfill" }>
): boolean => {
  if (edit.replaces === undefined) return true;
  const replaced = document.fulfillments.find((entry) => entry.id === edit.replaces);
  return replaced !== undefined && sameKey(replaced, edit.fulfillment);
};
const availableMark = (
  remaining: RecurringDocument["fulfillments"],
  edit: Extract<RecurringEdit, { kind: "fulfill" }>
): boolean => {
  const mark = edit.fulfillment;
  if (remaining.some((entry) => entry.id === mark.id)) return false;
  if (mark.transactionId === undefined) return true;
  if (remaining.some((entry) => entry.transactionId === mark.transactionId)) return false;
  return !remaining.some((entry) => sameKey(entry, mark) && entry.transactionId === undefined);
};
const fulfill = (
  document: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "fulfill" }>
): Option.Option<RecurringDocument> => {
  const mark = edit.fulfillment;
  const selected = readRecurringOccurrence({ document, planId: mark.planId, date: mark.date });
  if (Option.isNone(selected)) return Option.none();
  const item = selected.value;
  if (!validOccurrencePayment(item, mark)) return Option.none();
  const remaining = document.fulfillments.filter((entry) => entry.id !== edit.replaces);
  if (!validReplacement(document, edit) || !availableMark(remaining, edit)) return Option.none();
  return Option.some({ ...document, fulfillments: [...remaining, mark] });
};
const suggestion = (
  document: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "suggestion" }>
): Option.Option<RecurringDocument> => {
  const suggestions = document.suggestions.filter((entry) => entry.seriesId !== edit.seriesId);
  if (edit.action === "restore") return Option.some({ ...document, suggestions });
  if (edit.action === "dismiss") {
    return Option.some({
      ...document,
      suggestions: [...suggestions, { seriesId: edit.seriesId, disposition: "dismissed" }],
    });
  }
  if (!document.plans.some((plan) => plan.id === edit.planId)) return Option.none();
  return Option.some({
    ...document,
    suggestions: [
      ...suggestions,
      { seriesId: edit.seriesId, disposition: "linked", planId: edit.planId },
    ],
  });
};
const create = (
  document: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "create" }>
): Option.Option<RecurringDocument> => {
  if (document.plans.some((plan) => plan.id === edit.id)) return Option.none();
  const next: RecurringDocument = {
    ...document,
    plans: [
      ...document.plans,
      {
        id: edit.id,
        revisions: [{ from: edit.plan.firstDate, plan: edit.plan }],
        pauses: [],
      },
    ],
  };
  return edit.seriesId === undefined
    ? Option.some(next)
    : suggestion(next, {
        kind: "suggestion",
        seriesId: edit.seriesId,
        action: "link",
        planId: edit.id,
      });
};
const skip = (
  document: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "skip" }>
): Option.Option<RecurringDocument> => {
  if (Option.isNone(readRecurringOccurrence({ document, planId: edit.planId, date: edit.date }))) {
    return Option.none();
  }
  if (document.fulfillments.some((entry) => sameKey(entry, edit))) return Option.none();
  const prior = document.exceptions.find((entry) => sameKey(entry, edit));
  return Option.some({
    ...document,
    exceptions: [
      ...document.exceptions.filter((entry) => !sameKey(entry, edit)),
      { ...prior, planId: edit.planId, date: edit.date, skipped: edit.skipped },
    ],
  });
};
const reverse = (
  document: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "reverse" }>
): Option.Option<RecurringDocument> => {
  const mark = document.fulfillments.find((entry) => entry.id === edit.fulfillmentId);
  const excluded = mark?.transactionId ?? edit.fulfillmentId;
  return Option.some({
    ...document,
    fulfillments: document.fulfillments.filter((entry) => entry.id !== edit.fulfillmentId),
    excludedTransactionIds: [...new Set([...document.excludedTransactionIds, excluded])],
  });
};
const decide = (
  document: RecurringDocument,
  edit: RecurringEdit
): Option.Option<RecurringDocument> => {
  switch (edit.kind) {
    case "create":
      return create(document, edit);
    case "edit":
      return scopedEdit(document, edit);
    case "lifecycle":
      return lifecycle(document, edit);
    case "fulfill":
      return fulfill(document, edit);
    case "reverse":
      return reverse(document, edit);
    case "suggestion":
      return suggestion(document, edit);
    case "skip":
      return skip(document, edit);
  }
};
/** Revision-bound pure transitions. Supplied financial associations require adapter validation before commit. */
export const applyRecurringEdit = ({
  document,
  command,
}: Readonly<{ document: RecurringDocument; command: RecurringCommand }>): Effect.Effect<
  RecurringDocument,
  InvalidRecurringEdit
> => {
  if (document.revision !== command.expectedRevision) return Effect.fail(invalid());
  const next = decide(document, command.edit);
  if (Option.isNone(next)) return Effect.fail(invalid());
  return Schema.decodeEffect(Schema.toType(RecurringDocument))({
    ...next.value,
    revision: document.revision + 1,
  }).pipe(Effect.mapError(invalid));
};

const validOccurrencePayment = (item: RecurringOccurrence, mark: RecurringFulfillment): boolean =>
  item.plan.currency === mark.money.currency && item.status !== "skipped";
