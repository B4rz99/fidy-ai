import { createHash, randomUUID } from "node:crypto";
import { DateTime, Effect, Layer, Option, Result, Schedule, Schema } from "effect";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import type {
  InterpretedStatementRow,
  NeedsReviewStatementRow,
  StatementColumnMapping,
} from "~/core/ingestion/model";
import { interpretStatementRows } from "~/core/ingestion/rules";
import { NeedsReviewItemId } from "~/core/ingestion/reference";
import { TransactionExtraction } from "~/core/transactions/model";
import { freePatCaller } from "~/shell/_shared/suggested-operations";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { captureStatementTransactionInScope } from "~/shell/transactions/mutations";
import { StatementColumnMapper } from "./column-mapper";
import { type ParsedStatement, type StatementParseFailed, parseStatementFile } from "./parser";
import {
  type ClaimedStatement,
  claimStatementSubmission,
  completeSubmissionInScope,
  failSubmission,
  findStatementMappingInScope,
  insertNeedsReviewItemInScope,
  insertStatementMappingInScope,
  ownsStatementClaimInScope,
  requeueSubmission,
} from "./repo";

/** Stable revision recorded on extracted outcomes and cached mappings. */
export const statementExtractorRevision = "statement-extractor-v1";
const maximumMappingAttempts = 3;
const valueShape = (value: string): string =>
  value
    .trim()
    .replace(/[0-9]+/gu, "D")
    .replace(/[\p{L}]+/gu, "A");

/** Fingerprints table structure without retaining account values in the mapping cache key. */
const formatFingerprint = (parsed: ParsedStatement): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        sourceFormat: parsed.sourceFormat,
        headers: parsed.headers.map((header) => header.trim().toLocaleLowerCase("en-US")),
        shapes: parsed.sampleRows.map((row) => row.map(valueShape)),
      })
    )
    .digest("hex");

const cachedMapping = (
  claimed: ClaimedStatement,
  fingerprint: string
): ReturnType<typeof findStatementMappingInScope> =>
  withUserTransaction(claimed.userId, findStatementMappingInScope(claimed.userId, fingerprint));

const mappingFor = Effect.fn("statementMappingFor")(function* (
  claimed: ClaimedStatement,
  parsed: ParsedStatement
) {
  const fingerprint = formatFingerprint(parsed);
  const cached = yield* cachedMapping(claimed, fingerprint);
  if (Option.isSome(cached)) return { fingerprint, mapping: cached.value };
  const mapper = yield* StatementColumnMapper;
  return { fingerprint, mapping: yield* mapper.mapColumns(parsed) };
});

const captureFailureReview = (
  outcome: Extract<InterpretedStatementRow<TransactionExtraction>, { outcome: "accepted" }>
): NeedsReviewStatementRow => ({
  outcome: "needs-review",
  recordNumber: outcome.recordNumber,
  reason: "canonical-validation-failed",
  knownMoney: Option.some(outcome.extraction.money),
  issues: [
    {
      path: "occurredAt",
      message: "The extracted row could not be captured as a canonical Transaction.",
    },
  ],
  evidence: outcome.evidence,
});

const insertReview = (
  claimed: ClaimedStatement,
  outcome: NeedsReviewStatementRow
): ReturnType<typeof insertNeedsReviewItemInScope> =>
  insertNeedsReviewItemInScope({
    id: NeedsReviewItemId.make(randomUUID()),
    userId: claimed.userId,
    submissionId: claimed.id,
    outcome,
    context: {
      serviceMarket: claimed.serviceMarket,
      locale: claimed.locale,
      timeZone: claimed.timeZone,
    },
    sourceFormat: claimed.sourceFormat,
    parserRevision: claimed.parserRevision,
    extractorRevision: statementExtractorRevision,
  });

const finalizeOutcome = Effect.fn("finalizeStatementOutcome")(function* (
  claimed: ClaimedStatement,
  outcome: InterpretedStatementRow<TransactionExtraction>
) {
  if (outcome.outcome === "needs-review") {
    yield* insertReview(claimed, outcome);
    return false;
  }
  const captured = yield* Effect.result(
    captureStatementTransactionInScope({
      userId: claimed.userId,
      caller: freePatCaller(["write"]),
      extraction: outcome.extraction,
      context: {
        serviceMarket: claimed.serviceMarket,
        locale: claimed.locale,
        timeZone: claimed.timeZone,
      },
      attestation: {
        statementSubmissionId: claimed.id,
        statementRecordNumber: outcome.recordNumber,
        statementContentHash: claimed.contentHash,
        sourceFormat: claimed.sourceFormat,
        parserRevision: InterpretationRevision.make(claimed.parserRevision),
        extractorRevision: InterpretationRevision.make(statementExtractorRevision),
      },
    })
  );
  if (Result.isSuccess(captured)) return true;
  yield* insertReview(claimed, captureFailureReview(outcome));
  return false;
});

type FinalizationInput = Readonly<{
  claimed: ClaimedStatement;
  parsed: ParsedStatement;
  fingerprint: string;
  mapping: StatementColumnMapping;
}>;

const finalize = Effect.fn("finalizeStatementSubmission")(function* (input: FinalizationInput) {
  const { claimed, parsed, fingerprint, mapping } = input;
  const interpreted = yield* interpretStatementRows(
    {
      rows: parsed.rows,
      mapping,
      timeZone: claimed.timeZone,
    },
    Schema.decodeUnknownEffect(TransactionExtraction)
  );
  yield* withUserTransaction(
    claimed.userId,
    Effect.gen(function* () {
      const ownsClaim = yield* ownsStatementClaimInScope(
        claimed.userId,
        claimed.id,
        claimed.claimId
      );
      if (!ownsClaim) return;
      yield* insertStatementMappingInScope({
        userId: claimed.userId,
        fingerprint,
        mapping,
        extractorRevision: statementExtractorRevision,
      });
      let acceptedRows = 0;
      for (const outcome of interpreted.outcomes) {
        if (yield* finalizeOutcome(claimed, outcome)) acceptedRows += 1;
      }
      yield* completeSubmissionInScope({
        userId: claimed.userId,
        id: claimed.id,
        claimId: claimed.claimId,
        accounting: {
          inputRows: interpreted.outcomes.length,
          acceptedRows,
          needsReviewRows: interpreted.outcomes.length - acceptedRows,
        },
        completedAt: yield* DateTime.now,
      });
    })
  );
});

const finalizeUnmappedRows = Effect.fn("finalizeUnmappedStatementRows")(function* (
  claimed: ClaimedStatement,
  parsed: ParsedStatement
) {
  yield* withUserTransaction(
    claimed.userId,
    Effect.gen(function* () {
      const ownsClaim = yield* ownsStatementClaimInScope(
        claimed.userId,
        claimed.id,
        claimed.claimId
      );
      if (!ownsClaim) return;
      for (const row of parsed.rows) {
        yield* insertReview(claimed, {
          outcome: "needs-review",
          recordNumber: row.recordNumber,
          reason: "mapping-unavailable",
          knownMoney: Option.none(),
          issues: [
            {
              path: "",
              message: "The statement format could not be mapped after bounded retries.",
            },
          ],
          evidence: row.evidence,
        });
      }
      yield* completeSubmissionInScope({
        userId: claimed.userId,
        id: claimed.id,
        claimId: claimed.claimId,
        accounting: {
          inputRows: parsed.rows.length,
          acceptedRows: 0,
          needsReviewRows: parsed.rows.length,
        },
        completedAt: yield* DateTime.now,
      });
    })
  );
});

const processClaimed = Effect.fn("processClaimedStatement")(function* (claimed: ClaimedStatement) {
  const parsed = yield* parseStatementFile(claimed.fileContent).pipe(
    Effect.map(Option.some),
    Effect.catchTag("StatementParseFailed", (failure: StatementParseFailed) =>
      Effect.flatMap(DateTime.now, (now) =>
        failSubmission({
          userId: claimed.userId,
          id: claimed.id,
          failureReason: failure.safeReason,
          claimId: claimed.claimId,
          completedAt: now,
        })
      ).pipe(Effect.as(Option.none<ParsedStatement>()))
    )
  );
  if (Option.isNone(parsed)) return;

  const mapping = yield* mappingFor(claimed, parsed.value).pipe(
    Effect.map(Option.some),
    Effect.catchTag("StatementColumnMappingFailed", () =>
      (claimed.attemptCount >= maximumMappingAttempts
        ? finalizeUnmappedRows(claimed, parsed.value)
        : requeueSubmission(claimed.userId, claimed.id, claimed.claimId)
      ).pipe(Effect.as(Option.none<{ fingerprint: string; mapping: StatementColumnMapping }>()))
    )
  );
  if (Option.isNone(mapping)) return;
  yield* finalize({
    claimed,
    parsed: parsed.value,
    fingerprint: mapping.value.fingerprint,
    mapping: mapping.value.mapping,
  });
});

/** Claims and processes at most one durable statement. */
export const processNextStatement = Effect.fn("processNextStatement")(function* () {
  const claimed = yield* claimStatementSubmission();
  if (Option.isSome(claimed)) {
    yield* processClaimed(claimed.value).pipe(
      Effect.withSpan("ingestion.processStatementSubmission", {
        attributes: {
          "fidy.user.id": claimed.value.userId,
          "fidy.statement_submission.id": claimed.value.id,
          "fidy.statement.source_format": claimed.value.sourceFormat,
        },
      })
    );
  }
});

/** Durable single-process worker; stale claims become claimable again after fifteen minutes. */
export const StatementIngestionWorkerLive = Layer.effectDiscard(
  processNextStatement().pipe(
    Effect.catchCause((cause) => Effect.logError("Statement ingestion iteration failed", cause)),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkScoped
  )
);
