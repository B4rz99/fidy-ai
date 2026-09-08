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

/** Evidence-backed DAVIbank Visa Oro purchase notification revision. */
export const format: NotificationEmailFormat = {
  id: NotificationFormatId.make("davibank-card"),
  revision: InterpretationRevision.make("davibank-card-v1"),
  routingAnchors: ["davibank"],
  interpret: (document, context) => {
    if (!document.text.includes("con tu tarjeta visa oro")) return Option.none();
    const accountHints = decodeAccountHints({ instrumentLabel: "visa oro" });
    const amountText = findField(document, ["monto"]);
    const dateText = findField(document, ["fecha"]);
    const timeText = findField(document, ["hora"]);
    const counterparty = findField(document, ["comercio"]);
    return Option.all({ accountHints, amountText, dateText, timeText, counterparty }).pipe(
      Option.flatMap((evidence) =>
        makeInterpretation({
          ...evidence,
          document,
          amountStyle: "comma-grouped",
          dateStyle: "slash",
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
