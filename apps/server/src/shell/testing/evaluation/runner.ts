import {
  Cause,
  Clock,
  Config,
  Context,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Option,
  Redacted,
  Schema,
} from "effect";
import {
  type CaseResult,
  type EvaluationCase,
  EvaluationFailure,
  RunPlan,
  RunReport,
} from "./model";
import { loadCorpus, sourceEvidence } from "./corpus";
import { incompleteCase, scoreRun } from "./scoring";
import { makeScenario, runEmail, runHosted, runStatement } from "./scenarios";
import { runSafety } from "./safety";
import { EvaluationRequestBudget } from "./request-budget";
import { CurrentAgentLimits } from "~/shell/agent/agent-service";
import { HostedInferenceError } from "~/shell/agent/hosted-inference";

const smokeCases = new Set(["hosted-query", "statement-refund-csv", "email-inline-png"]);
const commitPrefixLength = 12;
const maximumReportBytes = 1_000_000;
const maximumFailureTagCharacters = 80;

/** Provider adapters supply identity and generation controls without exposing request content. */
export class EvaluationProviderMetadata extends Context.Service<
  EvaluationProviderMetadata,
  {
    readonly provider: RunReport["provider"];
    readonly requestedModel: RunReport["requestedModel"];
    readonly generationSourcePath: string;
    readonly outputReserveTokens: number;
    readonly temperature: number;
    readonly parallelToolCalls: boolean;
    readonly providerStorage: boolean;
    readonly reasoningEffort: string;
    readonly truncation: string;
    readonly observedModelFallback: ReadonlyArray<string>;
  }
>()("@fidy/server/shell/testing/evaluation/runner/EvaluationProviderMetadata") {}

type EvaluationModePolicy = Readonly<{
  plan: RunPlan;
  requiresApproval: boolean;
  startupValidation: boolean;
  usesSafetyStack: boolean;
  selectCases: (cases: ReadonlyArray<EvaluationCase>) => ReadonlyArray<EvaluationCase>;
}>;

const modePolicies: Readonly<Record<RunPlan["mode"], EvaluationModePolicy>> = {
  smoke: {
    plan: RunPlan.make({
      mode: "smoke",
      repetitions: 1,
      maximumRequests: 60,
      maximumMillis: 600_000,
    }),
    requiresApproval: false,
    startupValidation: true,
    usesSafetyStack: false,
    selectCases: (cases) => cases.filter((entry) => smokeCases.has(entry.id)),
  },
  baseline: {
    plan: RunPlan.make({
      mode: "baseline",
      repetitions: 3,
      maximumRequests: 1_000,
      maximumMillis: 7_200_000,
    }),
    requiresApproval: true,
    startupValidation: true,
    usesSafetyStack: false,
    selectCases: (cases) => cases,
  },
  safety: {
    plan: RunPlan.make({
      mode: "safety",
      repetitions: 1,
      maximumRequests: 1,
      maximumMillis: 600_000,
    }),
    requiresApproval: false,
    startupValidation: false,
    usesSafetyStack: true,
    selectCases: (cases) => cases.filter((entry) => entry.kind === "safety"),
  },
};

/** Returns the closed execution policy; callers cannot weaken case selection or request bounds. */
export const evaluationPolicy = (mode: RunPlan["mode"]): EvaluationModePolicy => modePolicies[mode];

/** Returns the immutable request, repetition and deadline bounds for an evaluation mode. */
export const evaluationPlan = (mode: RunPlan["mode"]): RunPlan => evaluationPolicy(mode).plan;

const caseResult = (
  entry: EvaluationCase,
  repetition: number,
  checks: CaseResult["checks"]
): CaseResult => ({
  id: entry.id,
  repetition,
  track: entry.kind === "safety" ? "safety" : "quality",
  outcome: "scored",
  checks,
});

const completeResult = (
  entry: EvaluationCase,
  repetition: number,
  checks: ReadonlyArray<CaseResult["checks"][number]>
): CaseResult => {
  const first = checks[0];
  return first === undefined
    ? incompleteCase(entry, repetition, "harness-failed")
    : caseResult(entry, repetition, [first, ...checks.slice(1)]);
};

const failureTag = (failure: unknown): Option.Option<string> =>
  Schema.decodeUnknownOption(
    Schema.Struct({
      _tag: Schema.String.check(Schema.isMaxLength(maximumFailureTagCharacters)),
    })
  )(failure).pipe(Option.map((tagged) => tagged._tag));

const failureClassification = (failure: Option.Option<unknown>): string => {
  if (Option.isNone(failure)) return "HarnessFailure";
  if (failure.value instanceof HostedInferenceError) return failure.value.reason._tag;
  return Option.getOrElse(failureTag(failure.value), () => "HarnessFailure");
};

const failedResult = Effect.fn("Evaluation.failedResult")(function* (
  entry: EvaluationCase,
  repetition: number,
  cause: Cause.Cause<unknown>
) {
  const budget = yield* EvaluationRequestBudget;
  if (yield* budget.exhausted) return incompleteCase(entry, repetition, "budget-exhausted");
  const failure = Cause.findErrorOption(cause);
  const providerUnavailable =
    Option.isSome(failure) &&
    (failure.value instanceof HostedInferenceError ||
      Option.contains(failureTag(failure.value), "ModelUnavailable"));
  const classification = failureClassification(failure);
  process.stderr.write(`Evaluation case unavailable: ${entry.id} (${classification}).\n`);
  return incompleteCase(
    entry,
    repetition,
    providerUnavailable ? "provider-unavailable" : "harness-failed"
  );
});

const runCase = Effect.fn("Evaluation.runCase")(function* (
  entry: EvaluationCase,
  repetition: number,
  corpus: Effect.Success<typeof loadCorpus>
) {
  const scenario = yield* makeScenario();
  if (entry.kind === "hosted") {
    const attempted = yield* Effect.exit(runHosted(entry, scenario));
    return Exit.isFailure(attempted)
      ? yield* failedResult(entry, repetition, attempted.cause)
      : completeResult(entry, repetition, attempted.value);
  }
  if (entry.kind === "statement") {
    const attempted = yield* Effect.exit(runStatement(entry, scenario));
    return Exit.isFailure(attempted)
      ? yield* failedResult(entry, repetition, attempted.cause)
      : completeResult(entry, repetition, attempted.value);
  }
  if (entry.kind === "email") {
    const attempted = yield* Effect.exit(runEmail(entry, scenario, corpus));
    return Exit.isFailure(attempted)
      ? yield* failedResult(entry, repetition, attempted.cause)
      : completeResult(entry, repetition, attempted.value);
  }
  const attempted = yield* Effect.exit(runSafety(entry, scenario));
  return Exit.isFailure(attempted)
    ? yield* failedResult(entry, repetition, attempted.cause)
    : completeResult(entry, repetition, attempted.value);
});

const safeFileName = (
  mode: RunPlan["mode"],
  provider: RunReport["provider"],
  sourceCommit: string
): string =>
  `evaluation-results/es-co-v1-${provider}-${mode}-${sourceCommit.slice(0, commitPrefixLength)}.json`;

/** Writes only the schema-projected report and checks its byte bound before persistence. */
const writeReport = Effect.fn("Evaluation.writeReport")(function* (report: RunReport) {
  const fs = yield* FileSystem.FileSystem;
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RunReport))(report);
  const bytes = new TextEncoder().encode(encoded);
  if (bytes.length > maximumReportBytes) {
    return yield* new EvaluationFailure({ reason: "report-write-failed" });
  }
  yield* fs.makeDirectory("evaluation-results", { recursive: true });
  const path = safeFileName(report.plan.mode, report.provider, report.sourceCommit);
  yield* fs.writeFile(path, bytes);
  return path;
});

const assertLocalDatabase = Effect.fn("Evaluation.assertLocalDatabase")(function* () {
  const runtime = Redacted.value(yield* Config.redacted("DATABASE_URL"));
  const migration = Redacted.value(yield* Config.redacted("MIGRATION_DATABASE_URL"));
  const safe = yield* Effect.try({
    try: () => [new URL(runtime), new URL(migration)] as const,
    catch: () => new EvaluationFailure({ reason: "unsafe-environment" }),
  });
  const [runtimeUrl, migrationUrl] = safe;
  const isLocal = (url: URL): boolean =>
    url.hostname === "127.0.0.1" && url.pathname === "/fidy_evaluation";
  if (!isLocal(runtimeUrl) || !isLocal(migrationUrl)) {
    return yield* new EvaluationFailure({ reason: "unsafe-environment" });
  }
  if (runtimeUrl.username !== "fidy_runtime" || migrationUrl.username !== "postgres") {
    return yield* new EvaluationFailure({ reason: "unsafe-environment" });
  }
});

const reportedModels = (
  observed: ReadonlyArray<string>,
  fallback: ReadonlyArray<string>
): ReadonlyArray<string> => (observed.length > 0 ? observed : fallback);

const runCases = Effect.fn("Evaluation.runCases")(function* (
  entries: ReadonlyArray<EvaluationCase>,
  plan: RunPlan,
  corpus: Effect.Success<typeof loadCorpus>
) {
  const results: Array<CaseResult> = [];
  for (const entry of entries) {
    const repetitions = plan.repetitions;
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      results.push(yield* runCase(entry, repetition, corpus));
    }
  }
  return results;
});

/** Runs one immutable synthetic corpus through production controls under finite wall/request bounds. */
const executeEvaluation = Effect.fn("Evaluation.run")(function* (mode: RunPlan["mode"]) {
  yield* assertLocalDatabase();
  const startedAt = yield* DateTime.now;
  const startedMillis = yield* Clock.currentTimeMillis;
  const sourceCommit = yield* Config.string("FIDY_EVALUATION_SOURCE_COMMIT").pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))))
  );
  const corpus = yield* loadCorpus;
  const provider = yield* EvaluationProviderMetadata;
  const source = yield* sourceEvidence(provider.generationSourcePath);
  const policy = evaluationPolicy(mode);
  const plan = policy.plan;
  const results = yield* runCases(policy.selectCases(corpus.corpus.cases), plan, corpus);
  const budget = yield* EvaluationRequestBudget;
  const limits = yield* CurrentAgentLimits;
  const observedModels = reportedModels(
    yield* budget.observedModels,
    provider.observedModelFallback
  );
  const report = RunReport.make({
    revision: "evaluation-report-v1",
    corpusRevision: corpus.corpus.revision,
    corpusSha256: corpus.sha256,
    sourceCommit,
    sourceSha256: source.sourceSha256,
    provider: provider.provider,
    requestedModel: provider.requestedModel,
    observedModels,
    controls: {
      generationSha256: source.generationSha256,
      contractSha256: source.contractSha256,
      startupValidation: policy.startupValidation,
      maxIterations: limits.maxIterations,
      maxToolCallsPerTurn: limits.maxToolCallsPerTurn,
      maxToolResultCharacters: limits.maxToolResultCharacters,
      maxModelRoundMillis: limits.maxModelRoundMillis,
      outputReserveTokens: provider.outputReserveTokens,
      temperature: provider.temperature,
      parallelToolCalls: provider.parallelToolCalls,
      providerStorage: provider.providerStorage,
      reasoningEffort: provider.reasoningEffort,
      truncation: provider.truncation,
      notificationDeadlineMillis: 30_000,
    },
    plan,
    startedAt: DateTime.formatIso(startedAt),
    elapsedMillis: Math.round((yield* Clock.currentTimeMillis) - startedMillis),
    providerRequests: yield* budget.count,
    rejectedRequests: yield* budget.rejected,
    inputTokens: yield* budget.inputTokens,
    cachedInputTokens: yield* budget.cachedInputTokens,
    outputTokens: yield* budget.outputTokens,
    results,
    ...scoreRun(results),
  });
  const path = yield* writeReport(report);
  return { path, report };
});

/** Applies the plan's wall-clock ceiling around setup, execution, scoring and report projection. */
export const runEvaluation = Effect.fn("Evaluation.runBounded")(function* (mode: RunPlan["mode"]) {
  return yield* executeEvaluation(mode).pipe(
    Effect.timeout(`${evaluationPlan(mode).maximumMillis} millis`),
    Effect.mapError((failure) =>
      failure instanceof EvaluationFailure
        ? failure
        : new EvaluationFailure({ reason: "harness-failed" })
    )
  );
});
