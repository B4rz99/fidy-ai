import { reviewHasExpired } from "./expiry";
import { DateTime, Option } from "effect";
import type { Item } from "./model";

export const reviewReason = (item: Item): string => {
  switch (item.reason) {
    case "ambiguous-currency":
      return "Confirma la moneda de esta transacción";
    case "ambiguous-direction":
      return "Confirma si fue una entrada o una salida";
    case "missing-required-fact":
      return "Completa los datos que no pudimos identificar";
    case "processing-interrupted":
    case "model-unavailable":
    case "extraction-unavailable":
      return "No pudimos procesar el material. Puedes reintentar o completarlo";
    default:
      return "Revisa y completa los datos antes de crear la transacción";
  }
};
export const reviewTitle = (item: Item): string =>
  Option.match(reviewHasExpired(item) ? Option.none() : item.preview, {
    onSome: (preview) => preview.counterparty.trim() || "Transacción por completar",
    onNone: () => (item.source === "media" ? "Recibo por completar" : "Transacción por completar"),
  });
export const reviewAmount = (item: Item): string =>
  Option.match(reviewHasExpired(item) ? Option.none() : item.preview, {
    onNone: () => "Valor por completar",
    onSome: (preview) =>
      preview.amount === ""
        ? "Valor por completar"
        : `${Option.getOrElse(preview.currency, () => "Moneda por confirmar")} ${preview.amount}`,
  });
const millisecondsPerHour = 3_600_000;
const hoursPerDay = 24;
export const reviewExpiry = (item: Item): string => {
  if (item.status === "created") return "Transacción creada";
  if (item.status === "expired") return "Original vencido";
  const hours = Math.max(
    0,
    Math.ceil(
      (DateTime.toEpochMillis(item.expiresAt) - DateTime.toEpochMillis(DateTime.nowUnsafe())) /
        millisecondsPerHour
    )
  );
  if (hours === 0) return "Vence ahora";
  return hours <= hoursPerDay
    ? `Vence en ${hours} h`
    : `Vence en ${Math.ceil(hours / hoursPerDay)} días`;
};
