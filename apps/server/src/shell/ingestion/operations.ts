import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import {
  NeedsReviewItem,
  StatementSubmission,
  SubmitForExtractionInput,
} from "~/core/ingestion/model";
import { NeedsReviewItemId, StatementSubmissionId } from "~/core/ingestion/reference";
import { Transaction } from "~/core/transactions/model";
import { NotFound, PaywallRequired, ValidationFailed } from "~/shell/_shared/errors";
import { acceptedStatus } from "~/shell/_shared/http-status";
import { operationPolicy, patScoped } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";
import { ResolveNeedsReviewItemInput } from "./input";

const read = operationPolicy({
  access: patScoped("read"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});
const write = operationPolicy({
  access: patScoped("write"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});
const confirmedWrite = operationPolicy({
  access: patScoped("write"),
  requiredTier: "free",
  agentConfirmation: "required",
  kind: "mutation",
});

/** Canonical durable statement submission and visible review queue. */
export const IngestionGroup = HttpApiGroup.make("ingestion")
  .add(
    HttpApiEndpoint.post("submitForExtraction", "/ingestion/statements", {
      payload: SubmitForExtractionInput,
      success: OperationResponse(StatementSubmission).pipe(HttpApiSchema.status(acceptedStatus)),
      error: [PaywallRequired, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Idempotently queue one bounded CSV or XLSX statement. Free includes one lifetime backfill; effective Trial or Pro access permits ongoing submissions. Poll the returned submission and inspect NeedsReviewItems after completion."
      )
      .annotateMerge(write)
  )
  .add(
    HttpApiEndpoint.get("getStatementSubmission", "/ingestion/statements/:id", {
      params: Schema.Struct({ id: StatementSubmissionId }),
      success: OperationResponse(StatementSubmission),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Read one owned statement submission and its complete accepted/review row accounting."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("listNeedsReviewItems", "/ingestion/needs-review", {
      query: Schema.Struct({
        offset: Schema.OptionFromOptionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        limit: Schema.OptionFromOptionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
        ),
      }),
      success: OperationResponse(Schema.Array(NeedsReviewItem)),
    })
      .annotate(
        OpenApi.Description,
        "List up to 100 of the caller's visible statement rows requiring review, followed by retained resolution metadata. Use offset and limit to page; pending items include parser-bounded original row evidence."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.post("resolveNeedsReviewItem", "/ingestion/needs-review/:id/resolve", {
      params: Schema.Struct({ id: NeedsReviewItemId }),
      payload: ResolveNeedsReviewItemInput,
      success: OperationResponse(Transaction),
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Resolve one pending statement row using its captured ServiceMarket, locale, and time zone. Atomically create the Transaction and immutable statement-line SourceAttestation, then erase original row evidence."
      )
      .annotateMerge(confirmedWrite)
  );
