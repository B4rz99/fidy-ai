import { ReviewCommand, ReviewDraft } from "@fidy/server/client";
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
    currency: "COP",
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
export const deadline = (item: Item): string =>
  DateTime.format(item.expiresAt, {
    locale: "es-CO",
    timeZone: "America/Bogota",
    dateStyle: "medium",
    timeStyle: "short",
  });
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
      money: { amount: draft.amount.trim().replace(",", "."), currency: draft.currency },
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

export const mergeSuggestions = ({
  draft,
  suggested,
}: Readonly<{ draft: Draft; suggested: Draft }>): Draft => {
  const provided = new Set(draft.userProvidedFields);
  return {
    amount: suggestedText(provided.has("money"), draft.amount, suggested.amount),
    currency:
      provided.has("money") || suggested.amount === "" ? draft.currency : suggested.currency,
    direction: provided.has("direction")
      ? draft.direction
      : Option.orElse(suggested.direction, () => draft.direction),
    counterparty: suggestedText(
      provided.has("counterparty"),
      draft.counterparty,
      suggested.counterparty
    ),
    occurredAt: suggestedText(provided.has("occurredAt"), draft.occurredAt, suggested.occurredAt),
    categoryId: provided.has("categoryId")
      ? draft.categoryId
      : Option.orElse(suggested.categoryId, () => draft.categoryId),
    userProvidedFields: draft.userProvidedFields,
  };
};

const suggestedText = (provided: boolean, current: string, suggested: string): string =>
  provided || suggested === "" ? current : suggested;
