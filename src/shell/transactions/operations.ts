import { Schema, Struct } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import {
  CreateTransactionInput,
  SourceAttestation,
  Transaction,
  TransactionId,
  TransactionQueryValues,
  UpdateTransactionInput,
} from "~/core/transactions/model";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { createdStatus } from "~/shell/_shared/http-status";
import { operationPolicy } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

const read = operationPolicy({
  requiredScope: "read",
  requiredTier: "free",
  costClass: "cheap",
  agentConfirmation: "not-required",
});
const additiveWrite = operationPolicy({
  requiredScope: "write",
  requiredTier: "free",
  costClass: "cheap",
  agentConfirmation: "not-required",
});
const destructiveWrite = operationPolicy({
  requiredScope: "write",
  requiredTier: "free",
  costClass: "cheap",
  agentConfirmation: "required",
});

const TransactionQueryParameters = TransactionQueryValues.mapFields(Struct.map(Schema.optionalKey));

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
      error: [NotFound, ValidationFailed],
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
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "List the caller's visible Transactions, newest occurrence first. Any combination of from (inclusive), to (exclusive), Category id, counterparty text, direction, and Currency narrows the history; omit every filter for all visible history."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("getTransaction", "/transactions/:id", {
      params: Schema.Struct({ id: TransactionId }),
      success: OperationResponse(Transaction),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Fetch one visible Transaction of the caller by id. Unknown, deleted, and another user's ids all answer not_found."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.put("updateTransaction", "/transactions/:id", {
      params: Schema.Struct({ id: TransactionId }),
      payload: UpdateTransactionInput,
      success: OperationResponse(Transaction),
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Replace the editable facts of one visible Transaction, including Category, Counterparty, and notes. Send the complete corrected movement; omitting Counterparty or notes clears that fact. Existing SourceAttestations remain unchanged."
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
