import { DateTime, Option, Schema } from "effect";
import type { IanaTimeZone, Locale } from "~/core/_shared/context";
import { type ReadonlyMoney, currencyMetadata, encodeMoneyAmount } from "~/core/_shared/money";
import { categoryRows } from "~/core/categories/taxonomy";
import { TranscriptText } from "~/core/transcript/model";
import { CreateTransactionResponse } from "~/shell/transactions/operations";

const groupThousands = (integer: string): string =>
  integer.replaceAll(/\B(?=(?:\d{3})+(?!\d))/g, ".");

/** Formats exact Money for the sole enabled locale without converting its amount to a float. */
export const formatMoneyEsCo = (money: ReadonlyMoney): string => {
  const [integer = "0", fraction] = encodeMoneyAmount(money.amount).split(".");
  const localizedInteger = groupThousands(integer);
  if (fraction === undefined) return `${localizedInteger} ${money.currency}`;
  const localizedFraction = fraction.padEnd(currencyMetadata(money.currency).fractionalDigits, "0");
  return `${localizedInteger},${localizedFraction} ${money.currency}`;
};

const localDateParts = (instant: DateTime.Utc, locale: Locale, timeZone: IanaTimeZone): string =>
  new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  })
    .formatToParts(DateTime.toDateUtc(instant))
    .filter(({ type }) => type === "day" || type === "month" || type === "year")
    .map(({ type, value }) => `${type}:${value}`)
    .join("|");

const formatReceiptDate = ({
  locale,
  occurredAt,
  timeZone,
  turnStartedAt,
}: Readonly<{
  locale: Locale;
  occurredAt: DateTime.Utc;
  timeZone: IanaTimeZone;
  turnStartedAt: DateTime.Utc;
}>): string =>
  localDateParts(occurredAt, locale, timeZone) === localDateParts(turnStartedAt, locale, timeZone)
    ? "Hoy"
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
        DateTime.toDateUtc(occurredAt)
      );

const receiptValue = (value: string): string =>
  value
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll("\\", "\\\\")
    .replaceAll(/([*_~`])/gu, "\\$1");

/**
 * Renders a successful create-Transaction result as the exact financial facts the User can verify.
 * An absent result means the output no longer matches that canonical operation's response shape.
 */
export const renderTransactionReceipt = ({
  locale,
  output,
  timeZone,
  turnStartedAt,
}: Readonly<{
  locale: Locale;
  output: unknown;
  timeZone: IanaTimeZone;
  turnStartedAt: DateTime.Utc;
}>): Option.Option<TranscriptText> =>
  Schema.decodeUnknownOption(CreateTransactionResponse)(output).pipe(
    Option.flatMap(({ data: transaction }) =>
      Option.fromUndefinedOr(categoryRows.find(({ id }) => id === transaction.categoryId)).pipe(
        Option.map(({ label }) => {
          const heading = transaction.direction === "outflow" ? "Gasto" : "Ingreso";
          const lines = [
            `✅ **${heading} guardado**`,
            "",
            `**Valor:** ${formatMoneyEsCo(transaction.money)}`,
            ...Option.match(transaction.counterparty, {
              onNone: () => [],
              onSome: (counterparty) => [`**Contraparte:** ${receiptValue(counterparty)}`],
            }),
            `**Categoría:** ${label}`,
            `**Fecha:** ${formatReceiptDate({
              locale,
              occurredAt: transaction.occurredAt,
              timeZone,
              turnStartedAt,
            })}`,
            ...Option.match(transaction.notes, {
              onNone: () => [],
              onSome: (notes) => [`**Nota:** ${receiptValue(notes)}`],
            }),
          ];
          return TranscriptText.make(lines.join("\n"));
        })
      )
    )
  );
