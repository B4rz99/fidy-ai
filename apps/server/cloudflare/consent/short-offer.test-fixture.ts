import type { ConsentUnavailable, WeeklyConsentContext, WeeklyConsentOffer } from "./contract";
import type { Effect, Option } from "effect";
import { createWeeklyGovernorConsentOffer } from "./operations";

export const createWeeklyConsentOffer = (
  input: WeeklyConsentContext
): Effect.Effect<Option.Option<WeeklyConsentOffer>, ConsentUnavailable> =>
  createWeeklyGovernorConsentOffer({
    ...input,
    request: { _tag: "ShortOffer", origin: "proactive" },
  });
