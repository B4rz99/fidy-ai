import { Schema, Struct } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import {
  CreateTransactionInput,
  RestoredTransactionPair,
  SourceAttestation,
  Transaction,
  TransactionId,
  TransactionPairInput,
  TransactionPresentation,
  TransactionQueryValues,
  TransactionSearchQuery,
  UpdateTransactionInput,
} from "~/core/transactions/model";
import {
  NotFound,
  OperationResponse,
  ResourceLimited,
  ValidationFailed,
  createdStatus,
} from "~/shell/public-http/contract";
import { operationPolicy, patScoped } from "~/shell/_shared/operation-policy";

const read = operationPolicy({
  access: patScoped("read"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});
const additiveWrite = operationPolicy({
  access: patScoped("write"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});
const destructiveWrite = operationPolicy({
  access: patScoped("write"),
  requiredTier: "free",
  agentConfirmation: "required",
  kind: "mutation",
});

const TransactionQueryParameters = TransactionQueryValues.mapFields(Struct.map(Schema.optionalKey));
const UpdateTransactionParams = Schema.Struct({ id: TransactionId });

/** The canonical operation input of `transactions.createTransaction`, owned beside its endpoint. */
export const CreateTransactionCanonicalInput = Schema.Struct({ payload: CreateTransactionInput });

/** The canonical operation input of `transactions.updateTransaction`, owned beside its endpoint. */
export const UpdateTransactionCanonicalInput = Schema.Struct({
  params: UpdateTransactionParams,
  payload: UpdateTransactionInput,
});

/** The canonical operation input of `transactions.linkTransactions`, owned beside its endpoint. */
export const LinkTransactionsCanonicalInput = Schema.Struct({ payload: TransactionPairInput });

/** The canonical operation input of `transactions.unlinkTransactions`, owned beside its endpoint. */
export const UnlinkTransactionsCanonicalInput = Schema.Struct({ payload: TransactionPairInput });

/** Successful create response shared by canonical consumers that present the stored Transaction. */
export const CreateTransactionResponse = OperationResponse(Transaction);

/**
 * Caller-owned Transaction capture, history, correction, deletion, and retained provenance.
 * Identity comes from authentication; unknown and foreign record ids are indistinguishable.
 */
export const TransactionsGroup = HttpApiGroup.make("transactions")
  .add(
    HttpApiEndpoint.post("createTransaction", "/transactions", {
      payload: CreateTransactionInput,
      success: CreateTransactionResponse.pipe(HttpApiSchema.status(createdStatus)),
      error: [NotFound, ValidationFailed, ResourceLimited],
    })
      .annotate(
        OpenApi.Description,
        "Record one exact movement of Money for the caller. Include a Counterparty only when the captured material explicitly identifies the person or organization; omit it rather than inferring one from an item, purpose, or context. Supply a stable Category id when known; omit it only at capture so a user keyword rule or the categorization fallback can assign it before storage. The result includes the stored Category."
      )
      .annotateMerge(additiveWrite)
  )
  .add(
    HttpApiEndpoint.get("listTransactions", "/transactions", {
      query: TransactionQueryParameters,
      success: OperationResponse(Schema.Array(Transaction)),
      error: [ValidationFailed, ResourceLimited],
    })
      .annotate(
        OpenApi.Description,
        "List the caller's visible Transactions, newest occurrence first. Any combination of from (inclusive), to (exclusive), Category id, counterparty text, direction, and Currency narrows the history; omit every filter for all visible history."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("searchTransactions", "/transactions/search", {
      query: TransactionSearchQuery,
      success: OperationResponse(Schema.Array(Transaction)),
      error: [ValidationFailed, ResourceLimited],
    })
      .annotate(
        OpenApi.Description,
        "Search the caller's FinancialRecord by literal Counterparty or notes text. Supply 2–80 characters; results are bounded and ordered newest first. Follow the returned continuation to browse further matches."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("getTransaction", "/transactions/:id", {
      params: Schema.Struct({ id: TransactionId }),
      success: OperationResponse(TransactionPresentation),
      error: [NotFound, ResourceLimited],
    })
      .annotate(
        OpenApi.Description,
        "Fetch one owned Transaction by id. Independent records return directly; either member of a linked pair succeeds and explains the earliest-created visible Transaction. Unknown, deleted, and another user's ids all answer not_found."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.post("linkTransactions", "/transactions/link", {
      payload: TransactionPairInput,
      success: OperationResponse(TransactionPresentation),
      error: [NotFound, ValidationFailed, ResourceLimited],
    })
      .annotate(
        OpenApi.Description,
        "Link two exact owned Transactions that describe one purchase. Both originals and every SourceAttestation remain retained; ordinary history, Dashboard calculations, and Budget status use one effective Transaction under the earliest-created id."
      )
      .annotateMerge(additiveWrite)
  )
  .add(
    HttpApiEndpoint.post("unlinkTransactions", "/transactions/unlink", {
      payload: TransactionPairInput,
      success: OperationResponse(RestoredTransactionPair),
      error: [NotFound, ValidationFailed, ResourceLimited],
    })
      .annotate(
        OpenApi.Description,
        "Remove the exact reversible link, restore both original Transactions to ordinary reads, and remember that the pair stays separate. No Transaction or SourceAttestation is deleted or rewritten."
      )
      .annotateMerge(additiveWrite)
  )
  .add(
    HttpApiEndpoint.put("updateTransaction", "/transactions/:id", {
      params: UpdateTransactionParams,
      payload: UpdateTransactionInput,
      success: OperationResponse(Transaction),
      error: [NotFound, ValidationFailed, ResourceLimited],
    })
      .annotate(
        OpenApi.Description,
        "Correct only the supplied normalized facts on the same Transaction. Supply its current revision (zero at capture); stale revisions fail. Null clears Counterparty or notes. Explicit User decisions remain authoritative over later provider metadata. Keyword rule edits do not change past Transactions. SourceAttestations remain unchanged."
      )
      .annotateMerge(destructiveWrite)
  )
  .add(
    HttpApiEndpoint.delete("deleteTransaction", "/transactions/:id", {
      params: Schema.Struct({ id: TransactionId }),
      success: OperationResponse(TransactionId),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Permanently remove one Transaction from the caller's visible product history. It cannot be restored; immutable SourceAttestations remain retained as provenance."
      )
      .annotateMerge(destructiveWrite)
  )
  .add(
    HttpApiEndpoint.get("listSourceAttestations", "/transactions/:id/source-attestations", {
      params: Schema.Struct({ id: TransactionId }),
      success: OperationResponse(Schema.Array(SourceAttestation)),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Explain which captured market, locale, IANA time zone, source details, and interpretation revision produced one owned Transaction, including after its user-facing deletion. SourceAttestations are immutable."
      )
      .annotateMerge(read)
  );
