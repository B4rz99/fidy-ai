import { DateTime, Option, Schema } from "effect";
import { TranscriptText } from "../../../src/core/agent/contract";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
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
  return Option.map(DateTime.setZoneNamed(transaction.occurredAt, timeZone), (local) =>
    TranscriptText.make(
      `Registré ${encodeMoneyAmount(transaction.money.amount)} ${transaction.money.currency} con fecha ${DateTime.formatIsoDate(local)}. Referencia: ${transaction.id}.`
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
