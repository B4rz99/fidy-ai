import { ReviewCommand, ReviewDraft } from "@/transport/client";
import { DateTime, Option, Schema } from "effect";
import type { CanonicalSuccess } from "@/transport/client";

export type Workspace = CanonicalSuccess<"ingestion.getReviewWorkspace">["data"];
export type Item = Workspace["items"][number];
export type Detail = CanonicalSuccess<"ingestion.getReviewItem">["data"];
export type Draft = ReviewDraft;
export type Command = ReviewCommand;
export type Category = CanonicalSuccess<"categories.listCategories">["data"][number];
export type Field = Draft["userProvidedFields"][number];
export const emptyDraft = (): Draft =>
  Schema.decodeSync(ReviewDraft)({
    amount: "",
    counterparty: "",
    occurredAt: "",
    userProvidedFields: [],
  });
export const sources = { statement: "Extracto", email: "Correo", media: "Imagen" } as const;
export const statuses = {
  pending: "Pendiente",
  created: "Creada",
  skipped: "Omitida",
  expired: "Vencida",
} as const;
const deadlineFormatters = new Map<string, Intl.DateTimeFormat>();
const maximumDeadlineFormatters = 32;
export const deadline = (item: Item): string => {
  let formatter = deadlineFormatters.get(item.timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("es-CO", {
      timeZone: item.timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    });
    if (deadlineFormatters.size >= maximumDeadlineFormatters) deadlineFormatters.clear();
    deadlineFormatters.set(item.timeZone, formatter);
  }
  return formatter.format(DateTime.toEpochMillis(item.expiresAt));
};
export const editDraft = ({
  draft,
  field,
  value,
}: Readonly<{ draft: Draft; field: Field; value: Readonly<Record<string, string>> }>): Draft => {
  const current = Schema.encodeSync(ReviewDraft)(draft);
  return Option.getOrElse(
    Schema.decodeOption(ReviewDraft)({
      ...current,
      ...value,
      userProvidedFields: [...new Set([...draft.userProvidedFields, field])],
    }),
    () => draft
  );
};
export const creation = ({
  detail,
  draft,
}: Readonly<{ detail: Detail; draft: Draft }>): Option.Option<Command> =>
  Schema.decodeOption(Schema.toCodecJson(ReviewCommand))({
    _tag: "Create",
    id: detail.item.id,
    revision: detail.revision,
    ...Option.match(draft.categoryId, {
      onNone: () => ({}),
      onSome: (categoryId) => ({ categoryId }),
    }),
    extraction: {
      money: {
        amount: draft.amount.trim().replace(",", "."),
        ...Option.match(draft.currency, {
          onNone: () => ({}),
          onSome: (currency) => ({ currency }),
        }),
      },
      ...Option.match(draft.direction, {
        onNone: () => ({}),
        onSome: (direction) => ({ direction }),
      }),
      ...(draft.counterparty.trim() === "" ? {} : { counterparty: draft.counterparty.trim() }),
      occurredAt: draft.occurredAt,
    },
  });

export const localOccurrence = ({
  value,
  timeZone,
}: Readonly<{ value: string; timeZone: string }>): string =>
  Option.match(DateTime.make(value), {
    onNone: () => "",
    onSome: (date) => {
      const local = DateTime.setZone(date, DateTime.zoneMakeNamedUnsafe(timeZone));
      return `${DateTime.formatIsoDate(local)}T${DateTime.format(local, { hourCycle: "h23", hour: "2-digit", minute: "2-digit" })}`;
    },
  });
export const canonicalOccurrence = ({
  value,
  timeZone,
}: Readonly<{ value: string; timeZone: string }>): string =>
  Option.match(DateTime.makeZoned(value, { timeZone, adjustForTimeZone: true }), {
    onNone: () => "",
    onSome: DateTime.formatIso,
  });
