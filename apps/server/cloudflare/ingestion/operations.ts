import {
  localReviewPage,
  localSubmission,
  observeDocumentPublication,
} from "./internal/local-review-list";
import { retainDocumentOrigin as retainOrigin } from "./internal/local-document";
import {
  dispatchLocalForwarding as dispatchLocalForwardingOwned,
  isLocalForwardingOperation as isLocalForwardingOperationOwned,
  prepareLocalForwardingEnable as prepareAddress,
  readForwarding,
  reserveBatchForwarding as reserveBatchAddress,
} from "./internal/native-forwarding";
import {
  prepareLocalAbandon as localAbandon,
  prepareLocalDecision as localDecision,
  resolveOrigin,
} from "./internal/local-statement-decision";
import { prepareLocalReviewEdit as localEdit } from "./internal/local-review-edit";
import {
  dispatchLocalReview as localReview,
  isLocalReviewOperation as localReviewOperation,
  readReviewItem,
  workspace as reviewWorkspace,
} from "./internal/local-review";

import {
  browseReviewPageContext as browseContext,
  prepareBoundReviewPageContext as prepareContext,
} from "./internal/review-page-context";
import {
  browseReviewWorkspace as browseInbox,
  prepareBoundReviewWorkspace as prepareInbox,
} from "./internal/review-workspace";
import {
  browseReviewItem as browseItem,
  prepareBoundReviewItem as prepareItem,
} from "./internal/review-detail";
import { browseReviewMaterial as browseMaterial } from "./internal/review-material";
import { prepareBoundReviewMaterial as prepareMaterial } from "./internal/bound-review-material";
import { prepareReviewEdit as prepareEdit } from "./internal/review-edit";
import { reviewRefusal as refuseReview } from "./internal/review-audit";
import {
  type MediaAdmissionInput,
  type ReviewAuditWork,
  type ReviewEditWork,
  type ReviewQueryWork,
  StatementCoordinatorActivity,
  StatementDocumentUnavailable,
  StatementProcessingUnavailable,
} from "./contract";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
} from "../canonical-operations/contract";
import type { OutboundHttpService } from "../../src/shell/outbound-http/operations";
import type { WhatsAppBusinessPhoneNumberId } from "../../src/shell/channels/whatsapp/contract";
import type { HostedCanonicalCaller } from "../canonical-work/contract";
import { admitMedia } from "./internal/media-submissions";

import type { StagedStatementBytes } from "../../src/shell/ingestion/contract";
import { Effect, Option, Schema } from "effect";

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

export const acceptWhatsAppMedia = (input: MediaAdmissionInput): Effect.Effect<Response> =>
  admitMedia(input);

export const readHeldStatementQuery: typeof heldQuery = (input) => heldQuery(input);

export const prepareStatementSessionActivity: typeof sessionActivity = (input) =>
  sessionActivity(input);

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

export const readHeldStatementDocument: typeof readDocument = (input) => readDocument(input);
export const readHeldStatementDocumentSubmission: typeof readDocumentSubmission = (input) =>
  readDocumentSubmission(input);

export const prepareHeldStatementReviewDecision: typeof heldReview = (input) => heldReview(input);

export const prepareHeldStatementAbandonment: typeof heldAbandon = (input) => heldAbandon(input);

export const prepareStatementReviewDecision: typeof prepareReview = (input) => prepareReview(input);

export const prepareStatementAbandonment: typeof prepareAbandon = (work) => prepareAbandon(work);

export const statementClarificationRefusal: typeof legacyReviewRefusal = (input) =>
  legacyReviewRefusal(input);

export const prepareHeldStatementSubmission: typeof heldSubmission = (work) => heldSubmission(work);

export const uploadStagedStatement: typeof uploadStatement = (input) => uploadStatement(input);

export const readStatementSubmission: typeof readSubmission = (input) => readSubmission(input);

export const submitForExtractionInput: typeof decodeSubmission = (input) => decodeSubmission(input);

export const unavailableStatement = (): Response => unavailable();

export const forwardingAddressResponse: typeof addressResponse = (...input) =>
  addressResponse(...input);

export const readForwardingAddress: typeof readAddress = (...input) => readAddress(...input);

export const listNeedsReviewItems: typeof listReview = (input) => listReview(input);

export const processStatementSubmission: typeof processSubmission = (input) =>
  processSubmission(input);

export const failStatementSubmission: typeof failSubmission = (input) => failSubmission(input);

export const processForwardedEmail: typeof processEmail = (input) => processEmail(input);

export const prepareStatementSubmission: typeof statementMutationAdapter.prepare = (work) =>
  statementMutationAdapter.prepare(work);

export const presentStatementSubmission: typeof statementMutationAdapter.present = (value) =>
  statementMutationAdapter.present(value);

export const invalidStatementSubmission: typeof statementMutationAdapter.invalidRefusal = (work) =>
  statementMutationAdapter.invalidRefusal(work);

export const prepareForwardingAddress: typeof forwardingAddressMutationAdapter.prepare = (work) =>
  forwardingAddressMutationAdapter.prepare(work);

export const presentForwardingAddress: typeof forwardingAddressMutationAdapter.present = (value) =>
  forwardingAddressMutationAdapter.present(value);

export const invalidForwardingAddress: typeof forwardingAddressMutationAdapter.invalidRefusal = (
  work
) => forwardingAddressMutationAdapter.invalidRefusal(work);

export const prepareIngestionPendingWorkObservation: typeof pendingIngestionWork = (input) =>
  pendingIngestionWork(input);

export const prepareIngestionRetentionObservation: typeof overdueIngestionRetention = (input) =>
  overdueIngestionRetention(input);

export const validationFailed: typeof validation = (message) => validation(message);

export const browseReviewWorkspace = (input: ReviewQueryWork): Effect.Effect<Response> =>
  browseInbox(input);
export const browseReviewItem = (input: ReviewQueryWork): Effect.Effect<Response> =>
  browseItem(input);
export const browseReviewPageContext = (input: ReviewQueryWork): Effect.Effect<Response> =>
  browseContext(input);
export const browseReviewMaterial = (input: ReviewQueryWork): Effect.Effect<Response> =>
  browseMaterial(input);
export const prepareReviewEdit = (
  input: ReviewEditWork
): Effect.Effect<CanonicalMutationPreparation> => prepareEdit(input);
export const reviewRefusal = (input: ReviewAuditWork): CanonicalMutationRefusal =>
  refuseReview(input);

export const prepareBoundReviewWorkspace: typeof prepareInbox = (request) => prepareInbox(request);

export const prepareBoundReviewPageContext: typeof prepareContext = (request) =>
  prepareContext(request);

export const prepareBoundReviewMaterial: typeof prepareMaterial = (input) => prepareMaterial(input);

export const prepareBoundReviewItem: typeof prepareItem = (request) => prepareItem(request);

export const advanceStatementExtraction = (
  input: Readonly<{
    DB: D1Database;
    bucket: Option.Option<R2Bucket>;
    userId: string;
    activity: typeof StatementCoordinatorActivity.Type;
  }>
): Effect.Effect<"continue" | "settled", StatementProcessingUnavailable> =>
  Effect.gen(function* () {
    const activity = yield* Schema.decodeEffect(StatementCoordinatorActivity)(input.activity).pipe(
      Effect.mapError(() => new StatementProcessingUnavailable())
    );
    if (activity.userId !== input.userId) return yield* new StatementProcessingUnavailable();
    const work = { DB: input.DB, userId: input.userId, submissionId: activity.submissionId };
    if (activity._tag === "StatementFailed") {
      yield* failSubmission({ ...work, reason: "resource-limit" });
      return "settled";
    }
    if (Option.isNone(input.bucket)) return yield* new StatementProcessingUnavailable();
    const result = yield* processSubmission({
      ...work,
      STATEMENT_STAGING_BUCKET: input.bucket.value,
    });
    return result === "continue" ? "continue" : "settled";
  });

export const dispatchLocalForwarding: typeof dispatchLocalForwardingOwned = (...args) =>
  dispatchLocalForwardingOwned(...args);
export const isLocalForwardingOperation = (id: string): boolean =>
  isLocalForwardingOperationOwned(id);

export const dispatchLocalReview: typeof localReview = (unit) => localReview(unit);
export const isLocalReviewOperation: typeof localReviewOperation = (id) => localReviewOperation(id);

export const prepareLocalReviewEdit: typeof localEdit = (...args) => localEdit(...args);

export const prepareLocalStatementDecision: typeof localDecision = (...args) =>
  localDecision(...args);
export const prepareLocalStatementAbandonment: typeof localAbandon = (...args) =>
  localAbandon(...args);

export const reserveBatchForwarding: typeof reserveBatchAddress = (...args) =>
  reserveBatchAddress(...args);
export const prepareLocalForwardingEnable: typeof prepareAddress = (...args) =>
  prepareAddress(...args);

export const retainLocalStatementDocumentOrigin: typeof retainOrigin = (input) =>
  retainOrigin(input);

export const localHostedStatementOrigin: typeof resolveOrigin = (...args) => resolveOrigin(...args);
export const readLocalSubmission: typeof localSubmission = (...args) => localSubmission(...args);
export const readLocalReviewPage: typeof localReviewPage = (...args) => localReviewPage(...args);

export const readLocalReviewItem: typeof readReviewItem = (...args) => readReviewItem(...args);
export const readLocalReviewWorkspace: typeof reviewWorkspace = (...args) =>
  reviewWorkspace(...args);
export const readLocalForwarding: typeof readForwarding = (...args) => readForwarding(...args);

export const readLocalDocumentPublication: typeof observeDocumentPublication = (...args) =>
  observeDocumentPublication(...args);
