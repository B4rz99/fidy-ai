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
  submitForExtractionInput as decodeSubmission,
  validationFailed as validation,
} from "./internal/statement-ingestion";

export const submitForExtractionInput: typeof decodeSubmission = (input) => decodeSubmission(input);

export const validationFailed: typeof validation = (message) => validation(message);

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
