import { BigDecimal, DateTime, Option, Schema } from "effect";
import type { CanonicalInput } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";

export const CaptureDraft = Schema.Struct({
  amount: Schema.String,
  counterparty: Schema.String,
  occurredOn: Schema.String,
  direction: Schema.Literals(["inflow", "outflow"]),
});
export type CaptureDraft = typeof CaptureDraft.Type;
export const CaptureStatus = Schema.Literals(["idle", "saving", "saved", "failed", "uncertain"]);
export type CaptureStatus = typeof CaptureStatus.Type;
/** Parses browser input into the server-owned Transaction declaration, retaining exact decimal Money. */
export const captureInput = (
  configuration: Readonly<{ draft: CaptureDraft; timeZone: string }>
): Option.Option<CanonicalInput<"transactions.createTransaction">> => {
  const { draft, timeZone } = configuration;
  const amount = BigDecimal.fromString(draft.amount.trim().replace(",", "."));
  const zoned = DateTime.makeZoned(`${draft.occurredOn}T00:00:00.000Z`, {
    timeZone,
    adjustForTimeZone: true,
  });
  if (
    Option.isNone(amount) ||
    !BigDecimal.isPositive(amount.value) ||
    Option.isNone(zoned) ||
    DateTime.formatIsoDate(zoned.value) !== draft.occurredOn
  ) {
    return Option.none();
  }
  const counterparty = draft.counterparty.trim();
  const input: CanonicalInput<"transactions.createTransaction"> = {
    payload: {
      money: { amount: amount.value, currency: "COP" },
      direction: draft.direction,
      counterparty: counterparty.length === 0 ? Option.none() : Option.some(counterparty),
      notes: Option.none(),
      categoryId: Option.none(),
      occurredAt: DateTime.toUtc(zoned.value),
    },
  };
  return isCanonicalInput("transactions.createTransaction", input)
    ? Option.some(input)
    : Option.none();
};
export const initialCapture = ({
  timeZone,
  now,
}: Readonly<{ timeZone: string; now: DateTime.Utc }>): CaptureDraft => ({
  amount: "",
  counterparty: "",
  direction: "outflow",
  occurredOn: DateTime.formatIsoDate(DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(timeZone))),
});
