import { browserCrypto } from "@/browser/crypto";
import { DateTime, Effect } from "effect";
import type { CanonicalSuccess } from "@/transport/client";
import { type Edit, type Occurrence, money } from "./model";

export type PaymentAssociation = Readonly<{ replaces: string; settled: boolean }>;
export const settlementOptions = [
  { value: "partial", label: "Parcial" },
  { value: "settled", label: "Pago o ingreso completo" },
];

export const manualMarks = (item: Occurrence): Occurrence["fulfillments"] =>
  item.fulfillments.filter((mark) => mark.transactionId === undefined);

export const replacementOptions = (
  item: Occurrence
): ReadonlyArray<Readonly<{ value: string; label: string }>> => [
  { value: "", label: "Ninguno" },
  ...manualMarks(item).map((mark) => ({
    value: mark.id,
    label: `${mark.actualDate} · ${money(mark.money)}`,
  })),
];

export const defaultReplacement = (item: Occurrence): string => {
  const marks = manualMarks(item);
  return marks.length === 1 ? (marks[0]?.id ?? "") : "";
};

export const defaultAssociation = (item: Occurrence): PaymentAssociation => {
  const replaces = defaultReplacement(item);
  return {
    replaces,
    settled: manualMarks(item).find((mark) => mark.id === replaces)?.settled ?? false,
  };
};

export const associationBlocked = ({
  item,
  replaces,
}: Readonly<{ item: Occurrence; replaces: string }>): boolean => {
  const marks = manualMarks(item);
  if (marks.length > 1) return true;
  return replaces === "" ? marks.length > 0 : !marks.some((mark) => mark.id === replaces);
};

export const associateTransaction = ({
  item,
  transaction,
  replaces,
  settled,
}: Readonly<{
  item: Occurrence;
  transaction: Pick<
    CanonicalSuccess<"transactions.createTransaction">["data"],
    "id" | "money" | "occurredAt"
  >;
  replaces: string;
  settled: boolean;
}>): Edit => ({
  kind: "fulfill",
  ...(replaces === "" ? {} : { replaces }),
  fulfillment: {
    id: Effect.runSync(browserCrypto.randomUUIDv4().pipe(Effect.orDie)),
    planId: item.planId,
    date: item.date,
    actualDate: DateTime.formatIsoDate(
      DateTime.makeZonedUnsafe(transaction.occurredAt, { timeZone: item.plan.timeZone })
    ),
    money: transaction.money,
    settled,
    transactionId: transaction.id,
  },
});
