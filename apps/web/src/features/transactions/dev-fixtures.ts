import { Option, Schema } from "effect";
import {
  Category as CategorySchema,
  Currency,
  Transaction as TransactionSchema,
  currencyMetadata,
} from "@/transport/client";
import type { ComponentProps } from "react";
import type { Transaction } from "./presentation";
import type { TransactionWorkspace } from "./workspace-component";

export type PreviewProps = ComponentProps<typeof TransactionWorkspace>;

type FixtureCategory = PreviewProps["categories"][number];

export type PreviewDataset = "demo" | "worst" | "empty" | "one" | "many";

const uuidSuffixLength = 12;

const manyRowCount = 500;

const maximumCounterpartyLength = 120;

const maximumNotesLength = 500;

const manyAmountBase = 1000;

const manyAmountStep = 37;

const manyAmountRange = 900000;

const monthDayCount = 28;

const lastDigitModulo = 10;

const uid = (index: number): string =>
  `46000000-0000-4000-8000-${String(index + 1).padStart(uuidSuffixLength, "0")}`;

type Seed = Readonly<{
  counterparty: Option.Option<string>;
  direction: "inflow" | "outflow";
  currency: Currency;
  amount: string;
  day: string;
  notes: Option.Option<string>;
}>;

const base: Seed = {
  counterparty: Option.some("El Corral"),
  direction: "outflow",
  currency: "COP",
  amount: "25000",
  day: "05",
  notes: Option.none(),
};

const seeds: ReadonlyArray<Seed> = [
  {
    ...base,
    counterparty: Option.some(
      "Administración y mantenimiento extraordinario del conjunto residencial familiar Los Arrayanes — torre norte".slice(
        0,
        maximumCounterpartyLength
      )
    ),
    amount: "12345678901.99",
  },
  {
    ...base,
    counterparty: Option.some("bartholomew.fitzgerald@northwind-industries-holdings.example.com"),
    currency: "USD",
    amount: "999999.99",
    direction: "inflow",
    day: "07",
  },
  {
    ...base,
    counterparty: Option.some("J"),
    currency: "JPY",
    amount: "1",
    day: "09",
  },
  {
    ...base,
    counterparty: Option.some("家庭日用品・教育費・海外旅行の積立"),
    currency: "KWD",
    amount: "0.001",
    direction: "inflow",
    day: "11",
  },
  {
    ...base,
    counterparty: Option.some("👩🏽‍💻 Asesoría de tecnología y diseño — Đặng Thị Ngọc Hân"),
    currency: "EUR",
    amount: "0.01",
    day: "13",
  },
  {
    ...base,
    counterparty: Option.some("نور الهدى عبد الرحمن"),
    day: "14",
  },
  {
    ...base,
    counterparty: Option.some("Créditos & seguros <anuales> **renovación**"),
    amount: "0.01",
    direction: "inflow",
    day: "16",
  },
  {
    ...base,
    counterparty: Option.some("SeguroResponsabilidadCivilProfesionalInternacionalRenovaciónAnual"),
    notes: Option.some(
      "Renovación anual del seguro de responsabilidad civil profesional internacional contratado para la operación completa del negocio familiar durante el próximo período fiscal, incluyendo coberturas extendidas para filiales en el exterior y ajustes por inflación de las primas principales"
        .repeat(2)
        .slice(0, maximumNotesLength)
    ),
    day: "18",
  },
  { ...base, counterparty: Option.none(), direction: "inflow", amount: "0.01", day: "20" },
  {
    ...base,
    counterparty: Option.some("Ólafur Darri Ólafsson — honorarios internacionales"),
    currency: "USD",
    amount: "987654.32",
    direction: "inflow",
    day: "22",
  },
];

const categoryLabels = [
  "Mantenimiento y administración de propiedades familiares rurales e internacional",
  "SeguroResponsabilidadCivilProfesionalInternacionalRenovaciónAnual",
  "Á",
  "家庭日用品・教育費・海外旅行の積立",
  "👨‍👩‍👧‍👦 Educación y cuidados familiares",
];

const fixtureCategories = (
  categories: ReadonlyArray<FixtureCategory>
): ReadonlyArray<FixtureCategory> => {
  const source =
    categories.length > 0
      ? categories
      : categoryLabels.map((label, index) =>
          Schema.decodeSync(CategorySchema)({ id: uid(index), label })
        );

  return source.map((category, index) =>
    CategorySchema.make({
      ...category,
      label: CategorySchema.fields.label.make(
        categoryLabels[index % categoryLabels.length] ?? category.label
      ),
    })
  );
};

const fixtureMonth = (props: PreviewProps): string => {
  const fromFilter = Option.getOrElse(
    Option.map(props.monthFilter, (filter) => filter.value),
    () => ""
  );

  return fromFilter === "history" || fromFilter === "" ? "2026-11" : fromFilter;
};

type EncodedTransactionDraft = {
  -readonly [
    Field in keyof typeof TransactionSchema.Encoded
  ]: (typeof TransactionSchema.Encoded)[Field];
};

const makeTransaction = ({
  seed,
  index,
  categories,
  month,
}: Readonly<{
  seed: Seed;
  index: number;
  categories: ReadonlyArray<FixtureCategory>;
  month: string;
}>): Transaction => {
  const category = categories[index % categories.length];
  const occurredAt = `${month}-${seed.day}T12:30:00Z`;

  const encoded: EncodedTransactionDraft = {
    id: uid(index),
    money: { amount: seed.amount, currency: seed.currency },
    direction: seed.direction,
    categoryId: category?.id ?? uid(index),
    occurredAt,
    createdAt: occurredAt,
    revision: 1,
  };

  if (Option.isSome(seed.counterparty)) {
    encoded.counterparty = seed.counterparty.value;
  }

  if (Option.isSome(seed.notes)) {
    encoded.notes = seed.notes.value;
  }

  return Schema.decodeSync(TransactionSchema)(encoded);
};

const manyAmount = (index: number, currency: Currency): string => {
  const digits = currencyMetadata(currency).fractionalDigits;
  const whole = manyAmountBase + ((index * manyAmountStep) % manyAmountRange);

  return digits === 0
    ? String(whole)
    : `${whole}.${"0".repeat(digits - 1)}${index % lastDigitModulo}`;
};

const manyTransactions = (
  categories: ReadonlyArray<FixtureCategory>,
  month: string
): ReadonlyArray<Transaction> =>
  Array.from({ length: manyRowCount }, (_, index) => {
    const currency = Currency.literals[index % Currency.literals.length] ?? "COP";

    return makeTransaction({
      seed: {
        ...base,
        counterparty: Option.some(`Comercio recurrente número ${index + 1}`),
        amount: manyAmount(index, currency),
        currency,
        day: String(1 + (index % monthDayCount)).padStart(2, "0"),
      },
      index,
      categories,
      month,
    });
  });

const fixtureTransactions = ({
  props,
  dataset,
  categories,
}: Readonly<{
  props: PreviewProps;
  dataset: PreviewDataset;
  categories: ReadonlyArray<FixtureCategory>;
}>): ReadonlyArray<Transaction> => {
  if (dataset === "empty") return [];

  const month = fixtureMonth(props);

  if (dataset === "many") return manyTransactions(categories, month);

  return seeds
    .slice(0, dataset === "one" ? 1 : seeds.length)
    .map((seed, index) => makeTransaction({ seed, index, categories, month }));
};

export const previewProps = ({
  props,
  dataset,
}: Readonly<{ props: PreviewProps; dataset: PreviewDataset }>): PreviewProps => {
  if (dataset === "demo") return props;

  const categories = fixtureCategories(props.categories);

  return {
    ...props,
    categories,
    transactions: fixtureTransactions({ props, dataset, categories }),
    continuation: "complete",
    location: "None",
    locate: Option.none(),
    captureHistoryVersion: Option.none(),
    queryNotice: null,
    readOnly: false,
    editable: false,
    capture: false,
    onMore: (): void => undefined,
    onRetryMore: (): void => undefined,
    onRefresh: (): void => undefined,
  };
};
