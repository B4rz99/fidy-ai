import {
  activateMailbox as nativeActivateMailbox,
  mailboxProof as nativeMailboxProof,
} from "./internal/local-mailbox";
import {
  repairReplacementAlarm as nativeRepairReplacementAlarm,
  replacementRequest as nativeReplacementRequest,
} from "./internal/local-replacement";

import type {
  EmailPendingWorkObservationInput,
  EmailProofRequest,
  EmailProofStart,
  EmailRejectedWorkObservationInput,
  VerifiedEmailQueryInput,
} from "./contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

import {
  prepareEmailPendingWorkObservation as pendingWork,
  prepareEmailRejectedWorkObservation as rejectedWork,
} from "./internal/operational-observation";

import {
  completeBrowserPairingEmail as completePairing,
  startBrowserPairingEmail as startPairing,
} from "./internal/browser-pairing-email";
import {
  completeEmailReplacement as completeReplacement,
  requestEmailReplacement as requestReplacement,
} from "./internal/email-replacement";

export const startBrowserPairingEmail = (input: EmailProofStart): Promise<Response> =>
  startPairing(input);

export const completeBrowserPairingEmail = (input: EmailProofRequest): Promise<Response> =>
  completePairing(input);

export const requestEmailReplacement = (input: EmailProofStart): Promise<Response> =>
  requestReplacement(input);

export const completeEmailReplacement = (input: EmailProofRequest): Promise<Response> =>
  completeReplacement(input);

export const verifiedEmailQuery = ({ userId }: VerifiedEmailQueryInput): OwnedStatement => ({
  sql: "SELECT user_id AS userId, address AS emailAddress FROM verified_email_credentials WHERE user_id = ?",
  params: [userId],
});

export const prepareEmailPendingWorkObservation = (
  input: EmailPendingWorkObservationInput
): D1PreparedStatement => pendingWork(input);

export const prepareEmailRejectedWorkObservation = (
  input: EmailRejectedWorkObservationInput
): D1PreparedStatement => rejectedWork(input);

export const activateMailbox: typeof nativeActivateMailbox = (...args) =>
  nativeActivateMailbox(...args);

export const mailboxProof: typeof nativeMailboxProof = (...args) => nativeMailboxProof(...args);

export const repairReplacementAlarm: typeof nativeRepairReplacementAlarm = (...args) =>
  nativeRepairReplacementAlarm(...args);

export const replacementRequest: typeof nativeReplacementRequest = (...args) =>
  nativeReplacementRequest(...args);
