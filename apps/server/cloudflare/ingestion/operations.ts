import { browseReviewWorkspace as browseInbox } from "./internal/review-workspace";
import { browseReviewItem as browseItem } from "./internal/review-detail";
import { browseReviewMaterial as browseMaterial } from "./internal/review-material";
import { prepareReviewEdit as prepareEdit } from "./internal/review-edit";
import { reviewRefusal as refuseReview } from "./internal/review-audit";
import type { ReviewAuditWork, ReviewEditWork, ReviewQueryWork } from "./contract";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
} from "../canonical-operations/contract";
import type { OutboundHttpService } from "../../src/shell/outbound-http/operations";
import type { WhatsAppBusinessPhoneNumberId } from "../../src/shell/channels/whatsapp/contract";
import type { HostedCanonicalCaller } from "../canonical-work/contract";
import { admitMedia } from "./internal/media-submissions";
import { type MediaAdmissionInput, StatementDocumentUnavailable } from "./contract";
import type { StagedStatementBytes } from "../../src/shell/ingestion/contract";
import { Effect, Option } from "effect";

import {
  prepareStatementDocumentAdmission as documentAdmission,
  readHeldStatementDocument as readDocument,
  readHeldStatementDocumentReference as readDocumentReference,
  readHeldStatementDocumentSubmission as readDocumentSubmission,
  releaseHeldStatementDocumentUpload as releaseDocumentUpload,
  retrieveHeldStatementMedia,
  stageHeldStatementDocument as stageDocument,
  withHeldStatementDocumentUpload as withDocumentUpload,
} from "./internal/statement-document";
import { readHeldStatementQuery as heldQuery } from "./internal/statement-held-query";
import { prepareStatementSessionActivity as sessionActivity } from "./internal/statement-session";
import {
  prepareHeldStatementAbandonment as heldAbandon,
  prepareHeldStatementReviewDecision as heldReview,
  clarificationRefusal as legacyReviewRefusal,
  prepareStatementAbandonment as prepareAbandon,
  prepareStatementReviewDecision as prepareReview,
} from "./internal/statement-clarification-mutation";

import {
  overdueIngestionRetention,
  pendingIngestionWork,
} from "./internal/operational-observation";
import {
  submitForExtractionInput as decodeSubmission,
  readStatementSubmission as readSubmission,
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
import {
  prepareHeldStatementSubmission as heldSubmission,
  statementMutationAdapter,
} from "./internal/statement-mutation";
import { forwardingAddressMutationAdapter } from "./internal/forwarding-address-mutation";

/** Atomically accept an authenticated image with its media unit, attribution, visible review and capacity reservation. Exact delivery replay is free; no provider retrieval occurs here. */
export const acceptWhatsAppMedia = (input: MediaAdmissionInput): Effect.Effect<Response> =>
  admitMedia(input);

/** Share installed queries with the verified upload conversation without borrowing credentials. */
export const readHeldStatementQuery: typeof heldQuery = (input) => heldQuery(input);

/** Compose clarification deadlines and permanent session boundaries in Agent's lifecycle unit. */
export const prepareStatementSessionActivity: typeof sessionActivity = (input) =>
  sessionActivity(input);

/** Admit direct attachment evidence in Agent's guarded Turn transaction. */
export const prepareStatementDocumentAdmission: typeof documentAdmission = (input) =>
  documentAdmission(input);
type HeldStatementDocumentWork = Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  caller: HostedCanonicalCaller;
  outbound: OutboundHttpService;
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  current: number;
}>;

/** Recover retained bytes without a download or new charge; otherwise admit, retrieve and stage
 * the live Turn's document, releasing its upload lease. The reference grants no publication authority.
 */
export const recoverHeldStatementDocument = (
  work: HeldStatementDocumentWork
): Effect.Effect<StagedStatementBytes, StatementDocumentUnavailable> =>
  Effect.gen(function* () {
    const uncertain = (): StatementDocumentUnavailable =>
      new StatementDocumentUnavailable({ reason: "uncertain" });
    const retained = yield* readDocumentReference(work).pipe(Effect.mapError(uncertain));
    if (Option.isSome(retained)) {
      yield* releaseDocumentUpload(work).pipe(Effect.mapError(uncertain));
      return retained.value;
    }
    const mediaId = yield* readDocument(work).pipe(Effect.mapError(uncertain));
    if (Option.isNone(mediaId)) return yield* uncertain();
    return yield* withDocumentUpload({
      ...work,
      work: (grant) =>
        Effect.gen(function* () {
          const media = yield* retrieveHeldStatementMedia({ ...work, mediaId: mediaId.value }).pipe(
            Effect.mapError(() => new StatementDocumentUnavailable({ reason: "media-unavailable" }))
          );
          return yield* stageDocument({ ...work, grant, bytes: media.bytes }).pipe(
            Effect.mapError(
              (failure) =>
                new StatementDocumentUnavailable({
                  reason:
                    failure._tag === "StatementStagingFailed" ? "invalid-material" : "uncertain",
                })
            )
          );
        }),
    }).pipe(
      Effect.mapError((failure) =>
        failure instanceof StatementDocumentUnavailable
          ? failure
          : new StatementDocumentUnavailable({
              reason: failure._tag === "ResourceAdmissionRefused" ? "rate-limited" : "uncertain",
            })
      )
    );
  });

/** Read only the admitted upload's media identity under live held authority. */
export const readHeldStatementDocument: typeof readDocument = (input) => readDocument(input);
export const readHeldStatementDocumentSubmission: typeof readDocumentSubmission = (input) =>
  readDocumentSubmission(input);

/** Share canonical row settlement with Agent's held, verified origin-session authority. */
export const prepareHeldStatementReviewDecision: typeof heldReview = (input) => heldReview(input);
/** Share canonical cancellation with Agent's held, verified origin-session authority. */
export const prepareHeldStatementAbandonment: typeof heldAbandon = (input) => heldAbandon(input);

/** Prepare a canonical row decision with capture, erasure, entitlement and Audit in one unit. */
export const prepareStatementReviewDecision: typeof prepareReview = (input) => prepareReview(input);
/** Prepare permanent explicit abandonment under live caller authority. */
export const prepareStatementAbandonment: typeof prepareAbandon = (work) => prepareAbandon(work);
/** Attribute a stale or foreign clarification without exposing source evidence. */
export const statementClarificationRefusal: typeof legacyReviewRefusal = (input) =>
  legacyReviewRefusal(input);

/** Publish staged bytes and verified origin through the shared hosted canonical unit. */
export const prepareHeldStatementSubmission: typeof heldSubmission = (work) => heldSubmission(work);

/** Stage bounded bytes under a live User session; the result grants no extraction authority. */
export const uploadStagedStatement: typeof uploadStatement = (input) => uploadStatement(input);
/** Read only the current caller's public submission lifecycle, with live authority and Audit. */
export const readStatementSubmission: typeof readSubmission = (input) => readSubmission(input);
/** Decode the bounded submission handle without accepting bytes or untrusted storage locators. */
export const submitForExtractionInput: typeof decodeSubmission = (input) => decodeSubmission(input);
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
/** Prepare admission and outbox publication for the caller's D1 unit; no nested commit is made. */
export const prepareStatementSubmission: typeof statementMutationAdapter.prepare = (work) =>
  statementMutationAdapter.prepare(work);
/** Present only committed canonical submission state. */
export const presentStatementSubmission: typeof statementMutationAdapter.present = (value) =>
  statementMutationAdapter.present(value);
/** Attribute invalid submission input with the owner's metadata-only refusal contract. */
export const invalidStatementSubmission: typeof statementMutationAdapter.invalidRefusal = (work) =>
  statementMutationAdapter.invalidRefusal(work);

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

export const browseReviewWorkspace = (input: ReviewQueryWork): Effect.Effect<Response> =>
  browseInbox(input);
export const browseReviewItem = (input: ReviewQueryWork): Effect.Effect<Response> =>
  browseItem(input);
export const browseReviewMaterial = (input: ReviewQueryWork): Effect.Effect<Response> =>
  browseMaterial(input);
export const prepareReviewEdit = (
  input: ReviewEditWork
): Effect.Effect<CanonicalMutationPreparation> => prepareEdit(input);
export const reviewRefusal = (input: ReviewAuditWork): CanonicalMutationRefusal =>
  refuseReview(input);
