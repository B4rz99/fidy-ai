import { DateTime, Predicate } from "effect";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { decideInsightDelivery } from "../../../src/core/insights/operations";

const dayMs = 86400000;

const zone = IanaTimeZone.make("America/Bogota");

export const disclosureWindowAt = (current: number): number => {
  const now = DateTime.makeUnsafe(current);

  const decision = decideInsightDelivery({
    now,
    scheduledAt: now,
    expiresAt: DateTime.makeUnsafe(current + dayMs),
    timeZone: zone,
  });

  return Predicate.isTagged(decision, "Deferred")
    ? decision.nextEligibleAt.epochMilliseconds
    : current;
};
