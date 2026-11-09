import { Option, Schema } from "effect";
import { TranscriptText } from "../../../src/core/agent/contract";
import {
  formatWhatsAppCategory as categoryText,
  formatWhatsAppLocalDate as localDateText,
  formatWhatsAppMoney as moneyText,
} from "../../../src/shell/channels/whatsapp/operations";
import { CreateTransactionResponse } from "../../../src/shell/transactions/contract";

const captured = Schema.toCodecJson(CreateTransactionResponse);

export const transactionReceipt = ({
  operation,
  output,
  timeZone,
}: Readonly<{
  operation: string;
  output: unknown;
  timeZone: string;
}>): Option.Option<TranscriptText> => {
  if (operation !== "transactions.createTransaction") return Option.none();
  const result = Schema.decodeUnknownOption(captured)(output);
  if (Option.isNone(result)) return Option.none();
  const transaction = result.value.data;
  return Option.map(localDateText({ date: transaction.occurredAt, timeZone }), (date) =>
    TranscriptText.make(
      `Registré ${transaction.direction === "inflow" ? "un ingreso" : "un gasto"} de ${moneyText(transaction.money)} en ${Option.getOrElse(categoryText(transaction.categoryId), () => "la categoría elegida")}, del ${date}.`
    )
  );
};

const captureVerb =
  /(?:^|[.!]\s+)(?:(?:por favor|fidy)[,:]?\s+)?(?:gast[eé]|pagu[eé]|compr[eé]|recib[ií]|cobr[eé]|registra|registrar|anota|anotar|guarda|guardar)(?=\s|$)/iu;
const compactCapture = /^(?:COP\s*|\$\s*)?\d[\d.,]*(?:\s*(?:mil|k|COP))?\s+\p{L}/iu;

export const captureWithoutCommit = ({
  request,
}: Readonly<{ request: string }>): Option.Option<TranscriptText> =>
  captureVerb.test(request) || compactCapture.test(request)
    ? Option.some(
        TranscriptText.make(
          "No pude confirmar el registro de esa transacción. Revisa tus movimientos antes de intentarlo de nuevo; si no aparece, vuelve a enviar el importe, la moneda y la fecha."
        )
      )
    : Option.none();
