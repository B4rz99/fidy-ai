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

/** Evidence-backed BBVA PSE notification revision. */
export const format: NotificationEmailFormat = {
  id: NotificationFormatId.make("bbva-pse"),
  revision: InterpretationRevision.make("bbva-pse-v1"),
  routingAnchors: ["pago pse"],
  interpret: (document, context) => {
    const transactionType = findField(document, ["tipo de transacción:", "tipo de transacción"]);
    if (Option.isNone(transactionType) || transactionType.value !== "pago pse") {
      return Option.none();
    }
    const suffix = findField(document, ["cuenta terminada en:", "cuenta terminada en"]);
    if (Option.isNone(suffix)) {
      return Option.none();
    }
    const suffixMatch = /^\*([0-9]{4})$/u.exec(suffix.value);
    if (suffixMatch === null) {
      return Option.none();
    }
    const accountHints = decodeAccountHints({ accountLastFour: suffixMatch[1] });
    const amountText = findField(document, ["valor:", "valor"]);
    const dateText = findField(document, ["fecha de la operación:", "fecha de la operación"]);
    const timeText = findField(document, ["hora:", "hora"]);
    const counterparty = findField(document, ["establecimiento:", "establecimiento"]);
    return Option.all({ accountHints, amountText, dateText, timeText, counterparty }).pipe(
      Option.flatMap((evidence) =>
        makeInterpretation({
          ...evidence,
          document,
          amountStyle: "comma-grouped-decimal",
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
