import { DateTime, Effect } from "effect";
import type { CanonicalInput } from "@/transport/client";

export type CaptureDraft = Readonly<{
  currency: CanonicalInput<"transactions.createTransaction">["payload"]["money"]["currency"];
  amount: string;
  counterparty: string;
  notes: string;
  categoryId: string;
  occurredOn: string;
  direction: "inflow" | "outflow";
}>;

export const emptyCaptureDraft = (timeZone: string): CaptureDraft => ({
  currency: "COP",
  amount: "",
  counterparty: "",
  notes: "",
  categoryId: "",
  direction: "outflow",
  occurredOn: DateTime.formatIsoDate(
    DateTime.setZone(Effect.runSync(DateTime.now), DateTime.zoneMakeNamedUnsafe(timeZone))
  ),
});
