import { Option } from "effect";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import { Currency } from "~/core/_shared/money";
import { NotificationFormatId } from "~/core/transactions/account-hints";
import type { NotificationEmailFormat } from "~/shell/ingestion/email-interpretation/format-definition";
import {
  decodeAccountHints,
  findField,
  makeInterpretation,
} from "~/shell/ingestion/email-interpretation/format-support";

/** Evidence-backed RappiCard purchase notification revision. */
export const format: NotificationEmailFormat = {
  id: NotificationFormatId.make("rappicard-purchase"),
  revision: InterpretationRevision.make("rappicard-purchase-v1"),
  routingAnchors: ["rappicard"],
  interpret: (document, context) => {
    if (!document.text.includes("realizaste una compra con tu rappicard")) return Option.none();
    const suffix = findField(document, ["método de pago"]);
    if (Option.isNone(suffix)) return Option.none();
    const suffixMatch = /^\*([0-9]{4})$/u.exec(suffix.value);
    if (suffixMatch === null) return Option.none();
    const accountHints = decodeAccountHints({
      cardLastFour: suffixMatch[1],
      instrumentLabel: "rappicard",
    });
    const amountText = findField(document, ["monto"]);
    const occurredText = findField(document, ["fecha de la transacción"]);
    const authorization = findField(document, ["no. de autorización"]);
    const counterparty = findField(document, ["comercio"]);
    if (Option.isNone(occurredText)) return Option.none();
    const occurredMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/u.exec(occurredText.value);
    if (occurredMatch === null) return Option.none();
    return Option.all({ accountHints, amountText, authorization, counterparty }).pipe(
      Option.flatMap((evidence) =>
        makeInterpretation({
          ...evidence,
          document,
          dateText: occurredMatch[1] ?? "",
          timeText: occurredMatch[2] ?? "",
          amountStyle: "dot-grouped",
          dateStyle: "dash",
          context,
          currencyDefault: {
            currency: Currency.make("COP"),
            basis: "format-cop-default-v1",
          },
        })
      )
    );
  },
};
