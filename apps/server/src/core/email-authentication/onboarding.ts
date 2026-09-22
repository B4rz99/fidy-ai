import { DateTime, Duration } from "effect";
import { IanaTimeZone, type Locale, type ServiceMarket } from "~/core/_shared/context";
import { TrialPeriod } from "~/core/identity/model";

const trialHours = 168;

/** A proof is redeemable only during both its own lifetime and the pending enrollment's lifetime. */
export const canRedeemOnboardingProof = (
  input: Readonly<{
    state: "awaiting_proof" | "awaiting_delivery" | "sending" | "rejected" | "ambiguous";
    expiresAtMs: number;
    proofExpiresAtMs: number;
    nowMs: number;
  }>
): boolean =>
  input.state === "awaiting_proof" &&
  input.expiresAtMs > input.nowMs &&
  input.proofExpiresAtMs > input.nowMs;

/** Launch context and the one nonrenewable TrialPeriod are fixed at verified User creation. */
export const verifiedOnboardingContext = (
  nowMs: number
): Readonly<{
  serviceMarket: ServiceMarket;
  locale: Locale;
  timeZone: IanaTimeZone;
  trialPeriod: TrialPeriod;
}> => ({
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: IanaTimeZone.make("America/Bogota"),
  trialPeriod: TrialPeriod.make({
    startedAt: DateTime.makeUnsafe(nowMs),
    endsAt: DateTime.makeUnsafe(nowMs + Duration.toMillis(Duration.hours(trialHours))),
  }),
});
