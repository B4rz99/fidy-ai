import { DateTime, Option, Schema } from "effect";
import { Currency, TransactionId } from "@/transport/client";
import type { ReviewDraft } from "@/transport/client";
import type { Detail, Workspace } from "./model";

export type PreviewDataset = "demo" | "worst" | "empty" | "one" | "many";

const manyRowCount = 50;

const uuidSuffixLength = 12;

const NeedsReviewItemId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("NeedsReviewItemId")
);

const IanaTimeZone = Schema.String.pipe(Schema.brand("IanaTimeZone"));

type Summary = Workspace["items"][number];

const uid = (index: number): string =>
  `66000000-0000-4000-8000-${String(index + 1).padStart(uuidSuffixLength, "0")}`;

const counterparties = [
  "Administración y mantenimiento extraordinario del conjunto residencial familiar Los Arrayanes",
  "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
  "J",
  "家庭日用品・教育費・海外旅行の積立",
  "👩🏽‍💻 Asesoría de tecnología y diseño — Đặng Thị Ngọc Hân",
  "نور الهدى عبد الرحمن",
  "Créditos & seguros <anuales> **renovación**",
  "SeguroResponsabilidadCivilProfesionalInternacionalRenovaciónAnual",
];

const missingPreviewIndex = 3;

const amounts: ReadonlyArray<Readonly<{ amount: string; currency: Currency }>> = [
  { amount: "1.234.567.890,99", currency: Currency.make("COP") },
  { amount: "999.999,99", currency: Currency.make("USD") },
  { amount: "1", currency: Currency.make("JPY") },
  { amount: "0,001", currency: Currency.make("KWD") },
  { amount: "0,01", currency: Currency.make("EUR") },
];

const defaultAmount = amounts[0] ?? { amount: "0", currency: Currency.make("COP") };

const reasons = [
  "extraction-unavailable",
  "unparseable-material",
  "canonical-validation-failed",
  "processing-interrupted",
];

const skippedModulo = 3;

const createdModulo = 5;

const sources: ReadonlyArray<Summary["source"]> = ["statement", "email", "media"];

const preview = (index: number): Summary["preview"] => {
  if (index === missingPreviewIndex) return Option.none();

  const amount = amounts[index % amounts.length] ?? defaultAmount;

  return Option.some({
    counterparty: counterparties[index % counterparties.length] ?? "Servicio",
    amount: amount.amount,
    currency: Option.some(amount.currency),
  });
};

const makeItem = ({
  index,
  status,
}: Readonly<{
  index: number;
  status: Summary["status"];
}>): Summary => {
  const metadata = {
    preview: preview(index),
    revision: 1,
    id: NeedsReviewItemId.make(uid(index)),
    source: sources[index % sources.length] ?? "statement",
    timeZone: IanaTimeZone.make("America/Bogota"),
    reason: reasons[index % reasons.length] ?? "extraction-unavailable",
    createdAt: DateTime.makeUnsafe("2026-10-15T10:00:00Z"),
    expiresAt: DateTime.makeUnsafe("2026-11-30T23:59:59Z"),
  };

  if (status === "created") {
    return { ...metadata, status, transactionId: TransactionId.make(uid(index + 100)) };
  }

  return { ...metadata, status, transactionId: Option.none() };
};

const statusFor = (scope: "pending" | "history", index: number): Summary["status"] => {
  if (scope === "pending") return "pending";

  if (index % skippedModulo === 0) return "skipped";

  return index % createdModulo === 0 ? "created" : "expired";
};

const fixtureItems = (
  dataset: PreviewDataset,
  scope: "pending" | "history"
): ReadonlyArray<Summary> => {
  if (dataset === "empty") return [];

  if (dataset === "one") {
    return [makeItem({ index: 0, status: statusFor(scope, 0) })];
  }

  if (dataset === "many") {
    return Array.from({ length: manyRowCount }, (_, index) =>
      makeItem({ index, status: statusFor(scope, index) })
    );
  }

  return counterparties.map((_, index) => makeItem({ index, status: statusFor(scope, index) }));
};

const draftAmounts = ["1234567890.99", "999999.99", "1", "0.001", "0.01"];

const fixtureDraft = (item: Summary, suggested: boolean): Option.Option<ReviewDraft> => {
  if (!Option.isSome(item.preview)) return Option.none();

  const index = counterparties.indexOf(item.preview.value.counterparty);
  const amount = draftAmounts[index >= 0 ? index % draftAmounts.length : 0];

  return Option.some({
    amount: suggested ? "0.01" : (amount ?? "25000"),
    currency: item.preview.value.currency,
    direction: Option.some("outflow" as const),
    counterparty: item.preview.value.counterparty,
    occurredAt: "2026-11-15",
    categoryId: Option.none(),
    userProvidedFields: suggested ? [] : ["money", "counterparty"],
  });
};

export const fixtureDetail = (item: Summary): Detail => ({
  item,
  revision: item.revision,
  draft: fixtureDraft(item, false),
  suggestions: fixtureDraft(item, true),
});

export const fixtureView = ({
  view,
  dataset,
  scope,
}: Readonly<{
  view: Workspace;
  dataset: PreviewDataset;
  scope: "pending" | "history";
}>): Workspace => {
  if (dataset === "demo") return view;

  const items = fixtureItems(dataset, scope);
  const pending = items.filter((item) => item.status === "pending").length;

  return {
    ...view,
    pendingCount: pending,
    total: items.length,
    items,
    selectedDetail: Option.none(),
  };
};
