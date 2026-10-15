import { BigDecimal, DateTime, Option, Schema } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { Currency, Money, type ReadonlyMoney } from "~/core/_shared/money";

const maximumNameLength = 120;
const maximumPlans = 100;
const maximumRevisions = 100;
const maximumRecords = 4096;
const maximumDay = 31;
/** Local calendar identity, independent of browser timezone or daylight-saving transitions. */
export const RecurringDate = Schema.String.check(
  Schema.isPattern(/^20\d{2}-\d{2}-\d{2}$/),
  Schema.makeFilter(
    (value: string) =>
      Option.exists(DateTime.make(value), (date) => DateTime.formatIsoDateUtc(date) === value) ||
      "Expected a valid local calendar date"
  )
);
export const RecurringMonth = Schema.String.check(Schema.isPattern(/^20\d{2}-(0[1-9]|1[0-2])$/));
export const RecurringPlanId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RecurringPlanId")
);
export type RecurringPlanId = typeof RecurringPlanId.Type;
export const RecurringFrequency = Schema.Literals([
  "weekly",
  "fortnightly",
  "twice-monthly",
  "monthly",
  "quarterly",
  "half-yearly",
  "yearly",
]);
const MonthDay = Schema.Union([
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumDay })),
  Schema.Literal("last"),
]);
const PositiveMoney = Money.check(
  Schema.makeFilter(
    (money: ReadonlyMoney) =>
      BigDecimal.Order(money.amount, BigDecimal.make(0n, 0)) > 0 || "Expected positive Money"
  )
);
const PlanShape = Schema.Struct({
  name: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(maximumNameLength)),
  kind: Schema.Literals(["income", "expense", "transfer"]),
  cardPayment: Schema.optionalKey(Schema.Boolean),
  currency: Currency,
  amountMode: Schema.Literals(["fixed", "estimated", "unknown"]),
  money: Schema.optionalKey(PositiveMoney),
  frequency: RecurringFrequency,
  monthDays: Schema.optionalKey(Schema.Tuple([MonthDay, MonthDay])),
  firstDate: RecurringDate,
  endDate: Schema.optionalKey(RecurringDate),
  timeZone: IanaTimeZone,
  counterparty: Schema.optionalKey(
    Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(maximumNameLength))
  ),
  categoryId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  accountId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
});
export const RecurringPlanInput = PlanShape.check(
  Schema.makeFilter((plan: RecurringPlanInput) => {
    if (plan.cardPayment === true && plan.kind !== "transfer") {
      return "Card payments must be transfers";
    }
    return true;
  }),
  Schema.makeFilter((plan: RecurringPlanInput) => {
    if (plan.endDate !== undefined && plan.endDate < plan.firstDate) return "End precedes start";
    if (plan.amountMode === "unknown") {
      return plan.money === undefined || "Unknown amount cannot be zero or Money";
    }
    return plan.money?.currency === plan.currency || "Expected positive Money in the plan Currency";
  }),
  Schema.makeFilter(
    (plan: RecurringPlanInput) =>
      plan.frequency !== "twice-monthly" ||
      (plan.monthDays !== undefined && plan.monthDays[0] !== plan.monthDays[1]) ||
      "Choose two different month days"
  )
);
export type RecurringPlanInput = Omit<typeof RecurringPlanInput.Type, "money"> &
  Partial<Readonly<{ money: ReadonlyMoney }>>;
const Revision = Schema.Struct({ from: RecurringDate, plan: RecurringPlanInput });
const Pause = Schema.Struct({ from: RecurringDate, through: Schema.optionalKey(RecurringDate) });
export const RecurringPlan = Schema.Struct({
  id: RecurringPlanId,
  revisions: Schema.NonEmptyArray(Revision).check(Schema.isMaxLength(maximumRevisions)),
  pauses: Schema.Array(Pause).check(Schema.isMaxLength(maximumRevisions)),
  stoppedOn: Schema.optionalKey(RecurringDate),
});
export type RecurringPlan = Omit<typeof RecurringPlan.Type, "revisions"> &
  Readonly<{
    revisions: readonly [
      Readonly<{ from: string; plan: RecurringPlanInput }>,
      ...Readonly<{ from: string; plan: RecurringPlanInput }>[],
    ];
  }>;
const OccurrenceKey = { planId: RecurringPlanId, date: RecurringDate };
export const RecurringFulfillment = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  ...OccurrenceKey,
  money: PositiveMoney,
  actualDate: RecurringDate,
  settled: Schema.Boolean,
  automatic: Schema.optionalKey(Schema.Boolean),
  transactionId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
});
export type RecurringFulfillment = Omit<typeof RecurringFulfillment.Type, "money"> &
  Readonly<{ money: ReadonlyMoney }>;
const Exception = Schema.Struct({
  ...OccurrenceKey,
  skipped: Schema.Boolean,
  replacement: Schema.optionalKey(RecurringPlanInput),
});
const SuggestionDecision = Schema.Struct({
  seriesId: Schema.String.check(Schema.isUUID()),
  disposition: Schema.Literals(["dismissed", "linked"]),
  planId: Schema.optionalKey(RecurringPlanId),
});
/** A bounded planning ledger. Historical detection and FinancialRecord remain separate owners. */
export const RecurringDocument = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  plans: Schema.Array(RecurringPlan).check(Schema.isMaxLength(maximumPlans)),
  exceptions: Schema.Array(Exception).check(Schema.isMaxLength(maximumRecords)),
  fulfillments: Schema.Array(RecurringFulfillment).check(Schema.isMaxLength(maximumRecords)),
  excludedTransactionIds: Schema.Array(Schema.String.check(Schema.isUUID())).check(
    Schema.isMaxLength(maximumRecords)
  ),
  suggestions: Schema.Array(SuggestionDecision).check(Schema.isMaxLength(maximumRecords)),
});
export type RecurringDocument = Omit<
  typeof RecurringDocument.Type,
  "plans" | "fulfillments" | "exceptions"
> &
  Readonly<{
    plans: ReadonlyArray<RecurringPlan>;
    fulfillments: ReadonlyArray<RecurringFulfillment>;
    exceptions: ReadonlyArray<
      Omit<typeof Exception.Type, "replacement"> &
        Partial<Readonly<{ replacement: RecurringPlanInput }>>
    >;
  }>;
export const RecurringEdit = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    id: RecurringPlanId,
    plan: RecurringPlanInput,
    seriesId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  }),
  Schema.Struct({
    kind: Schema.Literal("edit"),
    ...OccurrenceKey,
    scope: Schema.Literals(["once", "forward"]),
    plan: RecurringPlanInput,
  }),
  Schema.Struct({
    kind: Schema.Literal("lifecycle"),
    planId: RecurringPlanId,
    date: RecurringDate,
    action: Schema.Literals(["pause", "resume", "stop"]),
  }),
  Schema.Struct({ kind: Schema.Literal("skip"), ...OccurrenceKey, skipped: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("fulfill"),
    fulfillment: RecurringFulfillment,
    replaces: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  }),
  Schema.Struct({
    kind: Schema.Literal("reverse"),
    fulfillmentId: Schema.String.check(Schema.isUUID()),
  }),
  Schema.Struct({
    kind: Schema.Literal("suggestion"),
    seriesId: Schema.String.check(Schema.isUUID()),
    action: Schema.Literals(["dismiss", "restore", "link"]),
    planId: Schema.optionalKey(RecurringPlanId),
  }),
]);
export type RecurringEdit =
  | Exclude<typeof RecurringEdit.Type, { kind: "create" | "edit" | "fulfill" }>
  | (Omit<Extract<typeof RecurringEdit.Type, { kind: "create" }>, "plan"> &
      Readonly<{ plan: RecurringPlanInput }>)
  | (Omit<Extract<typeof RecurringEdit.Type, { kind: "edit" }>, "plan"> &
      Readonly<{ plan: RecurringPlanInput }>)
  | (Omit<Extract<typeof RecurringEdit.Type, { kind: "fulfill" }>, "fulfillment"> &
      Readonly<{ fulfillment: RecurringFulfillment }>);
export const RecurringCommand = Schema.Struct({
  expectedRevision: Schema.Int,
  edit: RecurringEdit,
});
export type RecurringCommand = Readonly<{ expectedRevision: number; edit: RecurringEdit }>;
export const RecurringOccurrence = Schema.Struct({
  ...OccurrenceKey,
  plan: RecurringPlanInput,
  expectedDate: RecurringDate,
  status: Schema.Literals(["upcoming", "unconfirmed", "partial", "completed", "skipped"]),
  completed: Money,
  remaining: Schema.optionalKey(Money),
  fulfillments: Schema.Array(RecurringFulfillment),
});
export type RecurringOccurrence = Omit<
  typeof RecurringOccurrence.Type,
  "plan" | "completed" | "remaining" | "fulfillments"
> &
  Readonly<{
    plan: RecurringPlanInput;
    completed: ReadonlyMoney;
    fulfillments: ReadonlyArray<RecurringFulfillment>;
  }> &
  Partial<Readonly<{ remaining: ReadonlyMoney }>>;

export class InvalidRecurringEdit extends Schema.Error<InvalidRecurringEdit>(
  "InvalidRecurringEdit"
)({ message: Schema.String }) {}
export const RecurringMatchFact = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  money: Money,
  date: RecurringDate,
  direction: Schema.Literals(["inflow", "outflow"]),
  counterparty: Schema.optionalKey(Schema.String),
  categoryId: Schema.String,
});
export type RecurringMatchFact = Omit<typeof RecurringMatchFact.Type, "money"> &
  Readonly<{ money: ReadonlyMoney }>;
export type RecurringMatch = Readonly<{ item: RecurringOccurrence; fact: RecurringMatchFact }>;
export const RecurringFilters = Schema.Struct({
  search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(maximumNameLength))),
  kind: Schema.optionalKey(PlanShape.fields.kind),
  frequency: Schema.optionalKey(RecurringFrequency),
  currency: Schema.optionalKey(Currency),
  categoryId: Schema.optionalKey(Schema.String),
  accountId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(
    Schema.Literals(["upcoming", "unconfirmed", "partial", "completed", "skipped"])
  ),
});
export type RecurringFilters = typeof RecurringFilters.Type;
export const RecurringSummary = Schema.Struct({
  kind: PlanShape.fields.kind,
  currency: Currency,
  completed: Money,
  remaining: Money,
  estimated: Money,
  unknown: Schema.Int,
});

export type RecurringSummary = Omit<
  typeof RecurringSummary.Type,
  "completed" | "remaining" | "estimated"
> &
  Readonly<{ completed: ReadonlyMoney; remaining: ReadonlyMoney; estimated: ReadonlyMoney }>;
