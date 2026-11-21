import { Option, Schema } from "effect";
import type {
  RecurringDigestItem,
  RecurringDigestReport,
} from "../../../src/core/insights/contract";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import { PreparedProactivityTemplate } from "../../../src/shell/channels/whatsapp/contract";

const compareItems = (left: RecurringDigestItem, right: RecurringDigestItem): number => {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [left.money.currency, right.money.currency],
    [left.counterparty, right.counterparty],
    [left.confirmationId, right.confirmationId],
  ];

  for (const [leftValue, rightValue] of pairs) {
    if (leftValue < rightValue) return -1;

    if (leftValue > rightValue) return 1;
  }

  return 0;
};

export const presentation = (report: RecurringDigestReport): string => {
  const heading = `Nuevos patrones históricos de cargos recurrentes del ${report.payload.confirmationDay.localDate}. No indica que sigan activos.`;
  const text = `${heading} ${report.payload.items.map((item) => `${item.counterparty}: ${encodeMoneyAmount(item.money.amount)} ${item.money.currency}; mensual.`).join(" ")}`;

  return Option.isSome(Schema.decodeOption(PreparedProactivityTemplate.fields.parameter)(text))
    ? text
    : `${heading} ${report.payload.items.length} patrones. Informe completo: https://app.fidyapp.com/insights/recurring/${report.insightEventId}`;
};

export const sortedDigestItems = (
  items: ReadonlyArray<RecurringDigestItem>
): ReadonlyArray<RecurringDigestItem> => items.toSorted(compareItems);
