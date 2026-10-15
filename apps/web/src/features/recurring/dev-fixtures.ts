import { BigDecimal } from "effect";
import {
  Category as CategorySchema,
  Currency,
  RecurringPlanId,
  RecurringPlanInput,
} from "@/transport/client";
import type { ComponentProps } from "react";
import type { RecurringWorkspace } from "./workspace";
import type { Category, Filters, Occurrence, Plan, PlanInput, Workspace } from "./model";

export type PreviewProps = ComponentProps<typeof RecurringWorkspace>;
export type Dataset = "demo" | "worst" | "empty" | "one" | "many" | "stale";
const planLimit = 100;
const weeks = 5;
const weekDays = 7;
const uuidDigits = 12;
const maxName = 120;
const fixtureToday = "2026-10-15";
type Seed = Readonly<{
  name: string;
  kind: PlanInput["kind"];
  currency: Currency;
  amount: string;
  mode: PlanInput["amountMode"];
  status: Occurrence["status"];
  date: string;
  lifecycle: "active" | "paused" | "stopped";
  category: boolean;
  account: boolean;
  card: boolean;
}>;
const base: Seed = {
  name: "Servicio",
  kind: "expense",
  currency: Currency.make("COP"),
  amount: "12345678.90",
  mode: "fixed",
  status: "upcoming",
  date: "2026-10-16",
  lifecycle: "active",
  category: true,
  account: false,
  card: false,
};
const seeds: ReadonlyArray<Seed> = [
  {
    ...base,
    name: "Administración y mantenimiento extraordinario del conjunto residencial familiar Los Arrayanes — torre norte, apartamento 804".slice(
      0,
      maxName
    ),
    kind: "income",
    amount: "12345678901.99",
    category: false,
  },
  {
    ...base,
    name: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
    currency: Currency.make("USD"),
    status: "partial",
    mode: "estimated",
    date: "2026-10-17",
  },
  {
    ...base,
    name: "J",
    currency: Currency.make("JPY"),
    amount: "1",
    status: "completed",
    kind: "transfer",
    card: true,
    date: "2026-10-18",
  },
  {
    ...base,
    name: "家庭日用品・教育費・海外旅行の積立",
    currency: Currency.make("KWD"),
    amount: "",
    mode: "unknown",
    date: "2026-10-19",
  },
  {
    ...base,
    name: "👩🏽‍💻 Asesoría de tecnología y diseño — Đặng Thị Ngọc Hân",
    currency: Currency.make("EUR"),
    amount: "0.01",
    status: "skipped",
    date: "2026-10-20",
  },
  {
    ...base,
    name: "نور الهدى عبد الرحمن",
    status: "unconfirmed",
    date: "2026-10-12",
    kind: "income",
  },
  {
    ...base,
    name: "Créditos & seguros <anuales> **renovación**",
    currency: Currency.make("USD"),
    amount: "0.01",
    category: false,
  },
  {
    ...base,
    name: "SeguroResponsabilidadCivilProfesionalInternacionalRenovaciónAnual",
    account: true,
  },
  {
    ...base,
    name: "Mantenimiento de propiedades familiares rurales y urbanas — apartamento 1004",
    kind: "transfer",
    card: true,
  },
  {
    ...base,
    name: "Mantenimiento de propiedades familiares rurales y urbanas — apartamento 1005",
    kind: "transfer",
    card: false,
  },
  {
    ...base,
    name: "Ólafur Darri Ólafsson — honorarios internacionales",
    kind: "income",
    currency: Currency.make("KWD"),
    amount: "0.001",
  },
  { ...base, name: "Internet hogar", kind: "transfer", card: true, mode: "unknown", amount: "" },
  { ...base, name: "Ahorro familiar", mode: "estimated" },
  { ...base, name: "Suscripción pausada", lifecycle: "paused" },
  { ...base, name: "Servicio dejado de seguir", lifecycle: "stopped" },
];
const categoryLabels = [
  "Mantenimiento y administración de propiedades familiares rurales e internacional",
  "SeguroResponsabilidadCivilProfesionalInternacionalRenovaciónAnual",
  "Á",
  "家庭日用品・教育費・海外旅行の積立",
  "👨‍👩‍👧‍👦 Educación y cuidados familiares",
];
const uid = (index: number): string =>
  `37000000-0000-4000-8000-${String(index + 1).padStart(uuidDigits, "0")}`;
export const fixtureCategories = (categories: ReadonlyArray<Category>): ReadonlyArray<Category> =>
  categories.map((category, index) =>
    CategorySchema.make({
      ...category,
      label: CategorySchema.fields.label.make(
        categoryLabels[index % categoryLabels.length] ?? category.label
      ),
    })
  );
const moneyFor = (currency: Currency, amount: string): Occurrence["completed"] => ({
  currency,
  amount: BigDecimal.fromStringUnsafe(amount),
});
const references = (
  seed: Seed,
  categories: ReadonlyArray<Category>,
  index: number
): Partial<PlanInput> => ({
  ...(seed.category && categories.length > 0
    ? { categoryId: categories[index % categories.length]?.id }
    : {}),
  ...(seed.account ? { accountId: uid(planLimit + index) } : {}),
  ...(seed.category ? { counterparty: seed.name } : {}),
});
const lifecycle = (seed: Seed): Pick<Plan, "pauses" | "stoppedOn"> => ({
  pauses: seed.lifecycle === "paused" ? [{ from: "2026-10-01" }] : [],
  ...(seed.lifecycle === "stopped" ? { stoppedOn: "2026-10-01" } : {}),
});
const makePlan = ({
  seed,
  index,
  categories,
  many,
}: Readonly<{
  seed: Seed;
  index: number;
  categories: ReadonlyArray<Category>;
  many: boolean;
}>): Plan => {
  const input = RecurringPlanInput.make({
    ...references(seed, categories, index),
    name: many ? `Servicio recurrente de propiedad familiar ${index + 1}` : seed.name,
    kind: seed.kind,
    cardPayment: seed.card,
    currency: seed.currency,
    amountMode: seed.mode,
    ...(seed.mode === "unknown" ? {} : { money: moneyFor(seed.currency, seed.amount) }),
    frequency: many ? "weekly" : "monthly",
    firstDate: many ? "2026-10-01" : seed.date.replace("2026-10", "2026-09"),
    timeZone: RecurringPlanInput.fields.timeZone.make("America/Bogota"),
  });
  return {
    id: RecurringPlanId.make(uid(index)),
    revisions: [{ from: input.firstDate, plan: input }],
    ...lifecycle(seed),
  };
};
const completedFor = (seed: Seed): Occurrence["completed"] => {
  if (seed.status === "completed") return moneyFor(seed.currency, seed.amount);
  return moneyFor(seed.currency, seed.status === "partial" ? "0.01" : "0");
};
const fulfillmentFor = (
  item: Omit<Occurrence, "fulfillments">,
  index: number
): Occurrence["fulfillments"] =>
  item.status === "completed" || item.status === "partial"
    ? [
        {
          id: uid(planLimit * weeks + index),
          planId: item.planId,
          date: item.date,
          actualDate: item.date,
          money: item.completed,
          settled: item.status === "completed",
        },
      ]
    : [];
const remainingFor = (
  plan: PlanInput,
  completed: Occurrence["completed"]
): Pick<Occurrence, "remaining"> =>
  plan.money === undefined
    ? {}
    : {
        remaining: moneyFor(
          plan.currency,
          BigDecimal.format(BigDecimal.subtract(plan.money.amount, completed.amount))
        ),
      };
const makeOccurrence = ({
  plan,
  seed,
  index,
  week,
  many,
}: Readonly<{
  plan: Plan;
  seed: Seed;
  index: number;
  week: number;
  many: boolean;
}>): Occurrence => {
  const date = many ? `2026-10-${String(1 + week * weekDays).padStart(2, "0")}` : seed.date;
  const input = { ...plan.revisions[0].plan, firstDate: date };
  const completed = completedFor(seed);
  const item = {
    planId: plan.id,
    date,
    expectedDate: date,
    plan: input,
    status: many && date < fixtureToday ? "unconfirmed" : seed.status,
    completed,
    ...remainingFor(input, completed),
  };
  return { ...item, fulfillments: fulfillmentFor(item, index) };
};
const addToSummary = (
  prior: Workspace["summary"][number],
  item: Occurrence
): Workspace["summary"][number] => {
  const currency = item.plan.currency;
  const remaining = item.remaining?.amount ?? BigDecimal.make(0n, 0);
  return {
    ...prior,
    completed: { currency, amount: BigDecimal.sum(prior.completed.amount, item.completed.amount) },
    remaining: { currency, amount: BigDecimal.sum(prior.remaining.amount, remaining) },
    estimated: {
      currency,
      amount: BigDecimal.sum(
        prior.estimated.amount,
        item.plan.amountMode === "estimated" ? remaining : BigDecimal.make(0n, 0)
      ),
    },
    unknown: prior.unknown + (item.remaining === undefined && item.status !== "completed" ? 1 : 0),
  };
};
const summaryFor = (items: ReadonlyArray<Occurrence>): Workspace["summary"] => {
  const groups = new Map<string, Workspace["summary"][number]>();
  for (const item of items.filter((entry) => entry.status !== "skipped")) {
    const { currency, kind } = item.plan;
    const zero = moneyFor(currency, "0");
    const prior = groups.get(`${kind}:${currency}`) ?? {
      kind,
      currency,
      completed: zero,
      remaining: zero,
      estimated: zero,
      unknown: 0,
    };
    groups.set(`${kind}:${currency}`, addToSummary(prior, item));
  }
  return [...groups.values()];
};
const matchesFilters = (item: Occurrence, filters: Filters): boolean =>
  Object.entries(filters).every(([key, value]) => {
    if (key === "search") {
      return `${item.plan.name} ${item.plan.counterparty ?? ""}`
        .toLowerCase()
        .includes(value.toLowerCase());
    }
    if (key === "status") return item.status === value;
    return Object.entries(item.plan).some(([field, text]) => field === key && text === value);
  });
const previousFor = (
  dataset: Dataset,
  items: ReadonlyArray<Occurrence>
): ReadonlyArray<Occurrence> => {
  const first = items[0];
  if (first === undefined || (dataset !== "worst" && dataset !== "stale")) return [];
  const date = "2026-09-16";
  return [
    {
      ...first,
      date,
      expectedDate: date,
      status: "unconfirmed",
      plan: { ...first.plan, firstDate: date },
    },
  ];
};
const counts: Readonly<Record<Dataset, number>> = {
  demo: 0,
  empty: 0,
  one: 1,
  many: planLimit,
  worst: seeds.length,
  stale: seeds.length,
};
export const fixtureWorkspace = ({
  dataset,
  categories,
  filters,
}: Readonly<{
  dataset: Dataset;
  categories: ReadonlyArray<Category>;
  filters: Filters;
}>): Workspace => {
  const many = dataset === "many";
  const selected = Array.from({ length: counts[dataset] }, (_, index) =>
    many ? base : (seeds[index] ?? base)
  );
  const plans = selected.map((seed, index) => makePlan({ seed, index, categories, many }));
  const all = plans.flatMap((plan, index) =>
    plan.pauses.length > 0 || plan.stoppedOn !== undefined
      ? []
      : Array.from({ length: many ? weeks : 1 }, (_, week) =>
          makeOccurrence({ plan, seed: selected[index] ?? base, index, week, many })
        )
  );
  const occurrences = all.filter((item) => matchesFilters(item, filters));
  return {
    month: "2026-10",
    today: fixtureToday,
    occurrences,
    previous: previousFor(dataset, all),
    previousMonth: "2026-09",
    summary: summaryFor(occurrences),
    matches: [],
    matchesComplete: dataset !== "stale",
    invalidFulfillmentIds: [],
    document: {
      revision: 1,
      plans,
      exceptions: many
        ? []
        : all.map((item) => ({
            planId: item.planId,
            date: item.date,
            skipped: item.status === "skipped",
            replacement: item.plan,
          })),
      fulfillments: all.flatMap((item) => item.fulfillments),
      excludedTransactionIds: [],
      suggestions: [],
    },
  };
};
