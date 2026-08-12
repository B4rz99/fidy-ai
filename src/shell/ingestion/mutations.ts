import { createHash, randomUUID } from "node:crypto";
import { DateTime, Effect, Encoding, Option, Result, Schema } from "effect";
import { Money } from "~/core/_shared/money";
import { decideEffectiveAccess } from "~/core/identity/rules";
import { type NeedsReviewItemId, StatementSubmissionId } from "~/core/ingestion/reference";
import type { SubmitForExtractionInput } from "~/core/ingestion/model";
import type { UserId } from "~/core/identity/reference";
import { InterpretationRevision, type TransactionExtraction } from "~/core/transactions/model";
import { NotFound, PaywallRequired, ValidationFailed } from "~/shell/_shared/errors";
import type { SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import {
  checkpointSuggestedOperations,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";
import { findUserInScope } from "~/shell/identity/repo";
import { captureStatementTransactionInScope } from "~/shell/transactions/mutations";
import {
  findPendingReviewItemInScope,
  findSubmissionByIdempotencyKeyInScope,
  insertSubmissionInScope,
  lockStatementBackfillInScope,
  reserveStatementBackfillInScope,
  resolveNeedsReviewItemInScope,
  statementAdmissionPressureInScope,
} from "./repo";
import { statementSourceFormat } from "./source-format";

/** Stable revision recorded on statement submissions and their provenance. */
export const statementParserRevision = "statement-parser-v1";
const bytesPerKibibyte = 1024;
const maximumStatementMebibytes = 5;
const maximumStatementBytes = maximumStatementMebibytes * bytesPerKibibyte * bytesPerKibibyte;

const invalidFileContent = (message: string): ValidationFailed =>
  ValidationFailed.make({
    error: {
      code: "validation_failed",
      message,
      fields: [{ path: "file.contentBase64", message }],
    },
    next: [],
  });

const decodedBytes = (content: string): Effect.Effect<Uint8Array, ValidationFailed> =>
  Result.match(Encoding.decodeBase64(content), {
    onFailure: () => Effect.fail(invalidFileContent("Expected valid base64 statement file bytes.")),
    onSuccess: (bytes) =>
      bytes.length <= maximumStatementBytes
        ? Effect.succeed(bytes)
        : Effect.fail(invalidFileContent("Expected a statement file no larger than 5 MiB.")),
  });

const paywall = (caller: SuggestedOperationCaller): PaywallRequired =>
  PaywallRequired.make({
    error: {
      code: "paywall_required",
      message:
        "This User has already used the lifetime Free statement backfill. Upgrade to Pro before submitting another statement.",
    },
    next: checkpointSuggestedOperations({
      caller,
      candidates: [
        suggestOperation({
          tool: "subscription.getUpgradeUrl",
          hint: "Get the upgrade destination for ongoing statement Ingestion.",
        }),
      ],
    }),
  });

const maximumOutstandingStatements = 5;
const maximumStatementsPerHour = 20;

const tooManyOutstandingStatements = (): ValidationFailed =>
  ValidationFailed.make({
    error: {
      code: "validation_failed",
      message: "Finish existing statement extraction work before uploading another file.",
      fields: [{ path: "file", message: "Too many statement files are already pending" }],
    },
    next: [],
  });

const idempotencyMismatch = (): ValidationFailed =>
  ValidationFailed.make({
    error: {
      code: "validation_failed",
      message: "The idempotency key already names different statement bytes. Use a new key.",
      fields: [
        {
          path: "idempotencyKey",
          message: "Expected the same file content previously submitted with this key",
        },
      ],
    },
    next: [],
  });

/** Admits one idempotent statement and atomically consumes Free access when necessary. */
export const submitForExtractionInScope = Effect.fn("submitForExtractionInScope")(
  function* (input: {
    readonly userId: UserId;
    readonly caller: SuggestedOperationCaller;
    readonly payload: SubmitForExtractionInput;
  }) {
    const bytes = yield* decodedBytes(input.payload.file.contentBase64);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const freeGrantConsumed = yield* lockStatementBackfillInScope(input.userId);
    const existing = yield* findSubmissionByIdempotencyKeyInScope(
      input.userId,
      input.payload.idempotencyKey
    );
    if (Option.isSome(existing)) {
      if (existing.value.contentHash !== contentHash) return yield* idempotencyMismatch();
      return { data: existing.value.submission, next: [] };
    }
    const pressure = yield* statementAdmissionPressureInScope(input.userId);
    if (
      pressure.outstanding >= maximumOutstandingStatements ||
      pressure.admittedThisHour >= maximumStatementsPerHour
    ) {
      return yield* tooManyOutstandingStatements();
    }
    const user = yield* findUserInScope(input.userId).pipe(
      Effect.flatMap(Effect.fromOption),
      Effect.orDie
    );
    const now = yield* DateTime.now;
    const access = yield* decideEffectiveAccess(user, now);
    if (access === "free" && freeGrantConsumed) return yield* paywall(input.caller);

    const sourceFormat = statementSourceFormat(bytes);
    const submissionId = StatementSubmissionId.make(randomUUID());
    const submission = yield* insertSubmissionInScope({
      id: submissionId,
      userId: input.userId,
      idempotencyKey: input.payload.idempotencyKey,
      contentHash,
      sourceFormat,
      fileContent: bytes,
      context: {
        serviceMarket: user.serviceMarket,
        locale: user.locale,
        timeZone: user.timeZone,
      },
      parserRevision: statementParserRevision,
      submittedAt: now,
    });
    if (access === "free") {
      yield* reserveStatementBackfillInScope(input.userId, submissionId);
    }
    return { data: submission, next: [] };
  }
);

const knownMoneyChanged = (): ValidationFailed =>
  ValidationFailed.make({
    error: {
      code: "validation_failed",
      message: "Resolution must preserve the Money already known from statement evidence.",
      fields: [
        {
          path: "extraction.money",
          message: "Expected the exact known amount and Currency",
        },
      ],
    },
    next: [],
  });

const moneyEquivalence = Schema.toEquivalence(Money);

const reviewNotFound = (id: NeedsReviewItemId): NotFound =>
  NotFound.make({
    error: {
      code: "not_found",
      message: `No pending NeedsReviewItem exists for id ${id}. Check the id and retry.`,
    },
    next: [],
  });

/** Resolves one rejected row under the caller-owned transaction and captured context. */
export const resolveNeedsReviewItemMutation = Effect.fn("resolveNeedsReviewItemMutation")(
  function* (
    input: Readonly<{
      userId: UserId;
      caller: SuggestedOperationCaller;
      id: NeedsReviewItemId;
      extraction: TransactionExtraction;
    }>
  ) {
    const row = yield* findPendingReviewItemInScope(input.userId, input.id).pipe(
      Effect.flatMap(Effect.fromOption(() => reviewNotFound(input.id)))
    );
    if (Option.isSome(row.knownAmount) && Option.isSome(row.knownCurrency)) {
      const knownMoney = Money.make({
        amount: row.knownAmount.value,
        currency: row.knownCurrency.value,
      });
      if (!moneyEquivalence(knownMoney, input.extraction.money)) {
        return yield* knownMoneyChanged();
      }
    }
    const transaction = yield* captureStatementTransactionInScope({
      userId: input.userId,
      caller: input.caller,
      extraction: input.extraction,
      context: {
        serviceMarket: row.serviceMarket,
        locale: row.locale,
        timeZone: row.timeZone,
      },
      attestation: {
        statementSubmissionId: row.submissionId,
        statementRecordNumber: row.recordNumber,
        statementContentHash: row.contentHash,
        sourceFormat: row.sourceFormat,
        parserRevision: InterpretationRevision.make(row.parserRevision),
        extractorRevision: InterpretationRevision.make(row.extractorRevision),
      },
    });
    yield* resolveNeedsReviewItemInScope({
      userId: input.userId,
      id: input.id,
      transactionId: transaction.id,
      resolvedAt: yield* DateTime.now,
    });
    return { data: transaction, next: [] };
  }
);
