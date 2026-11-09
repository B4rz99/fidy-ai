import { Schema, Struct } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  CreateTransactionInput,
  TransactionInspection as FinancialInspection,
  RestoredTransactionPair,
  Transaction,
  TransactionId,
  TransactionPairInput,
  TransactionPresentation,
  TransactionQueryValues,
  TransactionSearchQuery,
  UpdateTransactionInput,
} from "~/core/transactions/contract";
import { SourceAttestation, SourceAttestationKind } from "~/core/source-attestation/contract";
import {
  NotFound,
  OperationResponse,
  ResourceLimited,
  ValidationFailed,
  createdStatus,
} from "~/shell/public-http/contract";
import { operationPolicy, userOwnedAgentScoped } from "~/shell/canonical-policy/contract";

const CaptureSource = Schema.Struct({
  transactionId: TransactionId,
  kinds: Schema.Array(SourceAttestationKind).check(
    Schema.isMaxLength(SourceAttestation.members.length)
  ),
});
/** Adds bounded capture kinds without exposing retained source material. */
export const TransactionInspection = FinancialInspection.mapFields(
  (fields) => ({
    ...fields,
    sources: Schema.Array(CaptureSource).check(Schema.isMaxLength(2)),
  }),
  { unsafePreserveChecks: true }
).annotate({ identifier: "TransactionInspection" });
export type TransactionInspection = typeof TransactionInspection.Type;

const read = operationPolicy({
  access: userOwnedAgentScoped("read"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});
const additiveWrite = operationPolicy({
  access: userOwnedAgentScoped("write"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});
const destructiveWrite = operationPolicy({
  access: userOwnedAgentScoped("write"),
  requiredTier: "free",
  agentConfirmation: "required",
  kind: "mutation",
});

const TransactionQueryParameters = TransactionQueryValues.mapFields(Struct.map(Schema.optionalKey));
const UpdateTransactionParams = Schema.Struct({ id: TransactionId });

/** Resource bound for one revision-checked group correction, independent of UI selection. */
export const maximumCorrectionRecords = 4096;
export const UpdateTransactionsInput = Schema.Struct({
  transactions: Schema.NonEmptyArray(
    Schema.Struct({
      id: TransactionId,
      expectedRevision: UpdateTransactionInput.fields.expectedRevision,
    })
  ).check(
    Schema.isMaxLength(maximumCorrectionRecords),
    Schema.makeFilter(
      (records) => new Set(records.map((record) => record.id)).size === records.length
    )
  ),
  changes: UpdateTransactionInput.fields.changes,
}).annotate({ identifier: "UpdateTransactionsInput" });
export const UpdateTransactionsResult = Schema.Struct({
  updated: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumCorrectionRecords })),
});

/** Successful create response shared by canonical consumers that present the stored Transaction. */
export const CreateTransactionResponse = OperationResponse(Transaction);

/**
 * Caller-owned Transaction capture, history, correction, deletion, and retained provenance.
 * Identity comes from authentication; unknown and foreign record ids are indistinguishable.
 */
export const TransactionListResponse = OperationResponse(Schema.Array(Transaction));

export const TransactionsGroup = HttpApiGroup.make("transactions")
  .add(
    HttpApiEndpoint.post("updateTransactions", "/transactions/corrections", {
      payload: UpdateTransactionsInput,
      success: OperationResponse(UpdateTransactionsResult),
      error: [NotFound, ValidationFailed, ResourceLimited],
    })
      .annotate(
        OpenApi.Description,
        "Apply the same supplied corrections to an explicit selection of owned Transactions in one all-or-nothing save. Supply every selected id and its observed revision; missing, foreign, deleted, duplicate or stale selections never partially change history. Omitted fields retain each Transaction's existing value. SourceAttestations remain unchanged."
      )
      .annotateMerge(destructiveWrite)
  )
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
      success: TransactionListResponse,
      error: [ValidationFailed, ResourceLimited],
    })
      .annotate(
        OpenApi.Description,
        "List the caller's visible Transactions, newest occurrence first. Any combination of from (inclusive), to (exclusive), Category id, counterparty text, direction, Currency, and exact nominal amount narrows the history; omit every filter for all visible history. limit optionally bounds each response to 1–100 records (default 100); the keyset continuation remains valid when the limit changes."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("searchTransactions", "/transactions/search", {
      query: TransactionSearchQuery,
      success: TransactionListResponse,
      error: [ValidationFailed, ResourceLimited],
    })
      .annotate(
        OpenApi.Description,
        "Search the caller's FinancialRecord by literal Counterparty or notes text. Supply 2–80 characters and optionally combine the history date, direction, Currency, exact nominal amount and Category filters. limit bounds each response to 1–100 records (default 100). Results use effective Transactions and are ordered newest first; amounts compare exactly without currency conversion. Follow the returned continuation to browse further matches."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("getTransaction", "/transactions/:id", {
      params: Schema.Struct({ id: TransactionId }),
      success: OperationResponse(TransactionInspection),
      error: [NotFound, ResourceLimited],
    })
      .annotate(
        OpenApi.Description,
        "Fetch one owned Transaction by id. Independent records return directly; either member of a linked pair succeeds and explains the earliest-created visible Transaction. The reconciliation field exposes both retained originals for review before unlinking. Unknown, deleted, and another user's ids all answer not_found."
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
        "Permanently remove one Transaction from the caller's visible product history. It cannot be restored; immutable SourceAttestations remain retained as provenance. Unlink a Reconciliation pair before deleting either original."
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

export type { EffectiveTransactionAggregate, Transaction } from "~/core/transactions/contract";
