import type { ConsentUnavailable, WeeklyConsentContext, WeeklyConsentOffer } from "./contract";
import type { Effect, Option } from "effect";
import { createWeeklyGovernorConsentOffer } from "./operations";

/** Build the fixed short offer used by Consent and delivery test journeys. */
export const createWeeklyConsentOffer = (
  input: WeeklyConsentContext
): Effect.Effect<Option.Option<WeeklyConsentOffer>, ConsentUnavailable> =>
  createWeeklyGovernorConsentOffer({
    ...input,
    request: { _tag: "ShortOffer", origin: "proactive" },
  });
