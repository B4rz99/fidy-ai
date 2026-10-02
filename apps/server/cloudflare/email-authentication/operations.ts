import type {
  EmailPendingWorkObservationInput,
  EmailProofRequest,
  EmailProofStart,
  EmailRejectedWorkObservationInput,
  OnboardingEmailEnrollmentInput,
  OnboardingEmailReplayInput,
  OnboardingEmailStatusInput,
  VerifiedEmailQueryInput,
} from "./contract";
import type { Crypto, Effect, Option } from "effect";
import type { EmailStatus } from "@fidy/server/consent-contract";
import type { OwnedStatement } from "../../src/shell/_shared/owned-statement";

import {
  findOnboardingEmailReplay as findReplay,
  readOnboardingEmailStatus as readStatus,
  startOnboardingEmailEnrollment as startEnrollment,
} from "./internal/ingress-enrollment";
import { verifiedEmailQuery as mailboxQuery } from "./internal/ancillary-projections";
import {
  prepareEmailPendingWorkObservation as pendingWork,
  prepareEmailRejectedWorkObservation as rejectedWork,
} from "./internal/operational-observation";

import { verifyOnboarding as verify } from "./internal/verified-onboarding";
import {
  completeBrowserPairingEmail as completePairing,
  startBrowserPairingEmail as startPairing,
} from "./internal/browser-pairing-email";
import {
  completeEmailReplacement as completeReplacement,
  requestEmailReplacement as requestReplacement,
} from "./internal/email-replacement";

/** Consume one current onboarding proof; stable identity, mandatory mailbox and evidence commit together. */
export const verifyOnboarding = (input: EmailProofRequest): Promise<Response> => verify(input);
/** Request a bounded mailbox proof only after the browser proves its pending pairing; responses do not enumerate Users. */
export const startBrowserPairingEmail = (input: EmailProofStart): Promise<Response> =>
  startPairing(input);
/** Approve only the same pairing for the proved mailbox's existing User; no session is created. */
export const completeBrowserPairingEmail = (input: EmailProofRequest): Promise<Response> =>
  completePairing(input);
/** Begin a candidate-mailbox proof under current fresh WebSession authority; collisions stay non-enumerating. */
export const requestEmailReplacement = (input: EmailProofStart): Promise<Response> =>
  requestReplacement(input);
/** Verify the candidate before atomically replacing the User's sole credential; stale, foreign and replayed proofs fail closed. */
export const completeEmailReplacement = (input: EmailProofRequest): Promise<Response> =>
  completeReplacement(input);

/** Return only whether the exact accepted exchange's submission matches; mailbox evidence stays private. */
export const findOnboardingEmailReplay = (
  input: OnboardingEmailReplayInput
): Effect.Effect<Option.Option<"matching" | "conflict">, void> => findReplay(input);
/** Commit the accepted exchange's bounded mailbox enrollment and durable delivery identity together. */
export const startOnboardingEmailEnrollment = (
  input: OnboardingEmailEnrollmentInput
): Effect.Effect<string, void, Crypto.Crypto> => startEnrollment(input);
/** Observe only the safe delivery status of an already-authorized accepted Consent exchange. */
export const readOnboardingEmailStatus = (
  input: OnboardingEmailStatusInput
): Effect.Effect<EmailStatus, void> => readStatus(input);
/**
 * Project only userId and emailAddress for the exact User inside the caller's guarded D1 statement.
 * Possession of a UserId grants no authority: compose the live credential and purpose guards in
 * the same statement before releasing the mailbox. This query is not a reusable authorization.
 */
export const verifiedEmailQuery = (input: VerifiedEmailQueryInput): OwnedStatement =>
  mailboxQuery(input);
/** Observe at most eight pending work identities and deadlines; no User, mailbox or proof is released. */
export const prepareEmailPendingWorkObservation = (
  input: EmailPendingWorkObservationInput
): D1PreparedStatement => pendingWork(input);
/** Count a bounded recent rejection sample without exposing provider or proof evidence. */
export const prepareEmailRejectedWorkObservation = (
  input: EmailRejectedWorkObservationInput
): D1PreparedStatement => rejectedWork(input);
