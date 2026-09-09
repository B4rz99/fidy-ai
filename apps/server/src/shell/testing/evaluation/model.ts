import { Data, Schema, Struct } from "effect";
import {
  EmailNeedsReviewReason,
  type NeedsReviewItem,
  NeedsReviewReason,
} from "~/core/ingestion/model";
import { Transaction } from "~/core/transactions/model";

const maximumProseCharacters = 4_000;
const maximumCoverageLabels = 30;
const maximumFacts = 30;
const maximumReviews = 30;
const maximumSeedFacts = 10;
const maximumSteps = 5;
const maximumOperationCharacters = 80;
const maximumOperations = 12;
const maximumReplyEvidenceGroups = 5;
const maximumReplyAlternatives = 5;
const maximumColumns = 8;
const maximumRows = 31;
const maximumChecks = 12;
const maximumReportItems = 1_000;
const notificationDeadlineMillis = 30_000;
const maximumRepetitions = 10;
const maximumIsoCharacters = 30;

const identifier = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,79}$/u));
const prose = Schema.String.check(Schema.isMaxLength(maximumProseCharacters));
const count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }));
const tokenCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 }));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

/** Exact normalized facts, derived from the owning Transaction schema rather than a wire copy. */
export const FinancialFacts = Transaction.mapFields(
  Struct.pick(["money", "counterparty", "direction", "occurredAt", "categoryId"])
);
export type FinancialFacts = typeof FinancialFacts.Type;

/** A review expectation uses existing production reasons, not a invented ambiguity result. */
const ReviewReason = Schema.Union([NeedsReviewReason, EmailNeedsReviewReason]);

/** Source-independent coverage labels are reviewed before any provider is measured. */
export const Coverage = Schema.Literals([
  "reply",
  "query",
  "mutation",
  "confirmation",
  "malformed",
  "abstention",
  "unauthorized",
  "money",
  "currency",
  "direction",
  "date",
  "counterparty",
  "category",
  "duplicates",
  "refund",
  "reversal",
  "ambiguity",
  "pse",
  "nequi",
  "daviplata",
  "atm",
  "abono",
  "debito",
  "gmf",
  "4x1000",
  "inline-image",
  "injection",
  "unsupported",
]);

const commonCaseFields = {
  id: identifier,
  coverage: Schema.NonEmptyArray(Coverage).check(Schema.isMaxLength(maximumCoverageLabels)),
  expected: Schema.Array(FinancialFacts).check(Schema.isMaxLength(maximumFacts)),
  reviews: Schema.Array(ReviewReason).check(Schema.isMaxLength(maximumReviews)),
};
const hostedStep = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("message"), text: prose }),
  Schema.Struct({ kind: Schema.Literal("delete-first") }),
  Schema.Struct({ kind: Schema.Literal("confirm") }),
]);

/** Checked-in synthetic cases. No URLs, arbitrary file paths, User ids or credentials are inputs. */
export const EvaluationCase = Schema.Union([
  Schema.Struct({
    ...commonCaseFields,
    kind: Schema.Literal("hosted"),
    seed: Schema.Array(FinancialFacts).check(Schema.isMaxLength(maximumSeedFacts)),
    steps: Schema.NonEmptyArray(hostedStep).check(Schema.isMaxLength(maximumSteps)),
    operations: Schema.Array(
      Schema.String.check(
        Schema.isPattern(/^[a-zA-Z]+\.[a-zA-Z]+$/u),
        Schema.isMaxLength(maximumOperationCharacters)
      )
    ).check(Schema.isMaxLength(maximumOperations)),
    replyRubric: Schema.Literals(["grounded-es-co", "clarifies", "abstains", "confirms"]),
    replyIncludes: Schema.NonEmptyArray(
      Schema.NonEmptyArray(prose).check(Schema.isMaxLength(maximumReplyAlternatives))
    ).check(Schema.isMaxLength(maximumReplyEvidenceGroups)),
  }),
  Schema.Struct({
    ...commonCaseFields,
    kind: Schema.Literal("statement"),
    format: Schema.Literals(["csv", "xlsx"]),
    rows: Schema.NonEmptyArray(Schema.Array(prose).check(Schema.isMaxLength(maximumColumns))).check(
      Schema.isMaxLength(maximumRows)
    ),
  }),
  Schema.Struct({
    ...commonCaseFields,
    kind: Schema.Literal("email"),
    subject: prose,
    text: prose,
    image: Schema.Literals([
      "none",
      "receipt.png",
      "receipt.jpeg",
      "receipt.gif",
      "receipt.webp",
      "injection.png",
    ]),
    delivery: Schema.Literals([
      "once",
      "same-delivery",
      "same-content-new-delivery",
      "distinct-same-money",
    ]),
  }),
  Schema.Struct({
    ...commonCaseFields,
    kind: Schema.Literal("safety"),
    probe: Schema.Literals([
      "malformed",
      "unconfirmed",
      "altered-confirmation",
      "confirmation-replay",
      "wrong-scope",
      "cross-user",
      "tool-budget",
      "unknown-tool",
    ]),
  }),
]);
export type EvaluationCase = typeof EvaluationCase.Type;
export type HostedCase = Extract<EvaluationCase, { kind: "hosted" }>;
export type EmailCase = Extract<EvaluationCase, { kind: "email" }>;
export type StatementCase = Extract<EvaluationCase, { kind: "statement" }>;
export type SafetyCase = Extract<EvaluationCase, { kind: "safety" }>;

/** A revision and its bytes are immutable comparison evidence; gold changes require a new revision. */
export const Corpus = Schema.Struct({
  revision: identifier,
  provenance: Schema.Literal("synthetic-only"),
  context: Schema.Struct({
    serviceMarket: Schema.Literal("CO"),
    locale: Schema.Literal("es-CO"),
    timeZone: Schema.Literal("America/Bogota"),
  }),
  cases: Schema.NonEmptyArray(EvaluationCase).check(Schema.isMaxLength(100)),
});
export type Corpus = typeof Corpus.Type;

/** Execution has explicit finite bounds; changing these never changes production inference controls. */
export const RunPlan = Schema.Struct({
  mode: Schema.Literals(["smoke", "baseline", "safety"]),
  repetitions: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumRepetitions })),
  maximumRequests: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumReportItems })),
  maximumMillis: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 7_200_000 })),
});
export type RunPlan = typeof RunPlan.Type;

/** Closed check names keep financial differences, prose and provider failures out of reports. */
export const CheckId = Schema.Literals([
  "exact-financial-facts",
  "review-outcomes",
  "row-accounting",
  "canonical-operations",
  "confirmation-before-effect",
  "rejection",
  "no-unauthorized-effects",
  "audit-evidence",
  "reply-delivered",
  "reply-rubric",
  "no-unexpected-mutations",
]);
export const CheckResult = Schema.Struct({
  id: CheckId,
  critical: Schema.Boolean,
  status: Schema.Literals(["passed", "failed", "not-observed"]),
});
export type CheckResult = typeof CheckResult.Type;
export const CaseResult = Schema.Struct({
  id: identifier,
  repetition: count,
  track: Schema.Literals(["quality", "safety"]),
  outcome: Schema.Literals([
    "scored",
    "provider-unavailable",
    "budget-exhausted",
    "harness-failed",
  ]),
  checks: Schema.NonEmptyArray(CheckResult).check(Schema.isMaxLength(maximumChecks)),
});
export type CaseResult = typeof CaseResult.Type;
const Score = Schema.Struct({ planned: count, passed: count, failed: count, notObserved: count });

/** Only bounded metadata is retained; no free-form failure details or model/domain objects. */
export const RunReport = Schema.Struct({
  revision: Schema.Literal("evaluation-report-v1"),
  corpusRevision: identifier,
  corpusSha256: digest,
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  sourceSha256: digest,
  provider: identifier,
  requestedModel: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]{0,79}$/u)),
  controls: Schema.Struct({
    generationSha256: digest,
    contractSha256: digest,
    startupValidation: Schema.Boolean,
    maxIterations: count,
    maxToolCallsPerTurn: count,
    maxToolResultCharacters: count,
    maxModelRoundMillis: count,
    outputReserveTokens: count,
    temperature: Schema.Finite,
    parallelToolCalls: Schema.Literal(false),
    providerStorage: Schema.Literal(false),
    reasoningEffort: Schema.Literal("none"),
    truncation: Schema.Literal("disabled"),
    notificationDeadlineMillis: Schema.Literal(notificationDeadlineMillis),
  }),
  plan: RunPlan,
  startedAt: Schema.String.check(Schema.isMaxLength(maximumIsoCharacters)),
  elapsedMillis: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7_200_000 })),
  providerRequests: count,
  rejectedRequests: count,
  inputTokens: tokenCount,
  cachedInputTokens: tokenCount,
  outputTokens: tokenCount,
  results: Schema.Array(CaseResult).check(Schema.isMaxLength(maximumReportItems)),
  quality: Score,
  safety: Score,
  critical: Score,
  conclusion: Schema.Literals(["expectations-met", "expectations-failed", "incomplete"]),
});
export type RunReport = typeof RunReport.Type;

/** Safe command failure: never retain a Cause, SQL detail, boundary input or exception text. */
export class EvaluationFailure extends Data.TaggedError("EvaluationFailure")<{
  readonly reason:
    | "invalid-corpus"
    | "unsafe-environment"
    | "missing-credential"
    | "budget-exhausted"
    | "harness-failed"
    | "report-write-failed";
}> {}

/** Observations exist only in memory and are discarded after their checks have been projected. */
export type Observation = Readonly<{
  facts: ReadonlyArray<FinancialFacts>;
  reviews: ReadonlyArray<NeedsReviewItem>;
}>;
