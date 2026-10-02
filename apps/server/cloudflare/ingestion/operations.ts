import {
  overdueIngestionRetention,
  pendingIngestionWork,
} from "./internal/operational-observation";
import {
  submitForExtractionInput as decodeSubmission,
  readStatementSubmission as readSubmission,
  sweepExpiredUploadAdmission as sweepUploadAdmission,
  unavailableStatement as unavailable,
  uploadStagedStatement as uploadStatement,
  validationFailed as validation,
} from "./internal/statement-ingestion";
import {
  forwardingAddressResponse as addressResponse,
  readForwardingAddress as readAddress,
} from "./internal/forwarding-address";
import { listNeedsReviewItems as listReview } from "./internal/statement-review";
import {
  failStatementSubmission as failSubmission,
  processStatementSubmission as processSubmission,
} from "./internal/statement-processing";
import { processForwardedEmail as processEmail } from "./internal/forwarded-email-processing";
import { expireStatementReviewEvidence as expireReview } from "./internal/statement-review-retention";
import {
  statementDailyBudgetRefusal as budgetRefusal,
  statementMutationAdapter,
} from "./internal/statement-mutation";
import { forwardingAddressMutationAdapter } from "./internal/forwarding-address-mutation";

/** Stage bounded bytes under a live User session; the result grants no extraction authority. */
export const uploadStagedStatement: typeof uploadStatement = (input) => uploadStatement(input);
/** Read only the current caller's public submission lifecycle, with live authority and Audit. */
export const readStatementSubmission: typeof readSubmission = (input) => readSubmission(input);
/** Decode the bounded submission handle without accepting bytes or untrusted storage locators. */
export const submitForExtractionInput: typeof decodeSubmission = (input) => decodeSubmission(input);
/** Remove expired upload admission leases independently of material retention. */
export const sweepExpiredUploadAdmission: typeof sweepUploadAdmission = (input) =>
  sweepUploadAdmission(input);
/** Return the same closed unavailable answer without parser or storage details. */
export const unavailableStatement = (): Response => unavailable();
/** Read the owned forwarding address and monthly allowance under the caller's current authority. */
export const forwardingAddressResponse: typeof addressResponse = (...input) =>
  addressResponse(...input);
/** Read one User's decoded forwarding address after the caller's guarded unit commits. */
export const readForwardingAddress: typeof readAddress = (...input) => readAddress(...input);
/** Read the caller's bounded visible review lifecycle, retaining no other User's evidence. */
export const listNeedsReviewItems: typeof listReview = (input) => listReview(input);
/** Finalize one bounded statement chunk under the existing explicit User coordinator. */
export const processStatementSubmission: typeof processSubmission = (input) =>
  processSubmission(input);
/** Retain a visible closed failure and conserved completed-row accounting for interrupted extraction. */
export const failStatementSubmission: typeof failSubmission = (input) => failSubmission(input);
/** Recheck User, Consent, bytes and source eligibility before atomic Transaction-or-review finalization. */
export const processForwardedEmail: typeof processEmail = (input) => processEmail(input);
/** Expire personal review evidence while retaining item state and conserved accounting. */
export const expireStatementReviewEvidence: typeof expireReview = (input) => expireReview(input);
/** Prepare admission and outbox publication for the caller's D1 unit; no nested commit is made. */
export const prepareStatementSubmission: typeof statementMutationAdapter.prepare = (work) =>
  statementMutationAdapter.prepare(work);
/** Present only committed canonical submission state. */
export const presentStatementSubmission: typeof statementMutationAdapter.present = (value) =>
  statementMutationAdapter.present(value);
/** Attribute invalid submission input with the owner's metadata-only refusal contract. */
export const invalidStatementSubmission: typeof statementMutationAdapter.invalidRefusal = (work) =>
  statementMutationAdapter.invalidRefusal(work);
/** Classify only the shared budget refusal; no storage evidence leaves the owner. */
export const statementDailyBudgetRefusal: typeof budgetRefusal = (phase) => budgetRefusal(phase);
/** Prepare idempotent forwarding-address access and its Audit for the caller's D1 unit. */
export const prepareForwardingAddress: typeof forwardingAddressMutationAdapter.prepare = (work) =>
  forwardingAddressMutationAdapter.prepare(work);
/** Present only the owned committed forwarding address. */
export const presentForwardingAddress: typeof forwardingAddressMutationAdapter.present = (value) =>
  forwardingAddressMutationAdapter.present(value);
/** Keep malformed forwarding-address calls on the closed canonical refusal path. */
export const invalidForwardingAddress: typeof forwardingAddressMutationAdapter.invalidRefusal = (
  work
) => forwardingAddressMutationAdapter.invalidRefusal(work);

/** Observe at most eight pending identities for private operational health; this is not execution authority. */
export const prepareIngestionPendingWorkObservation: typeof pendingIngestionWork = (input) =>
  pendingIngestionWork(input);
/** Observe bounded due retention timestamps without exposing retained personal evidence. */
export const prepareIngestionRetentionObservation: typeof overdueIngestionRetention = (input) =>
  overdueIngestionRetention(input);

/** Reject malformed statement input without echoing hostile bytes or diagnostics. */
export const validationFailed: typeof validation = (message) => validation(message);
