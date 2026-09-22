import { Duration } from "effect";
import { IanaTimeZone, type Locale, type ServiceMarket } from "~/core/_shared/context";

const trialHours = 168;
/** A fourth wrong proof closes the pending enrollment; later attempts cannot revive it. */
export const maximumOnboardingProofFailures = 4;

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
  trialPeriod: Readonly<{ startedAtMs: number; endsAtMs: number }>;
}> => ({
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: IanaTimeZone.make("America/Bogota"),
  trialPeriod: {
    startedAtMs: nowMs,
    endsAtMs: nowMs + Duration.toMillis(Duration.hours(trialHours)),
  },
});
