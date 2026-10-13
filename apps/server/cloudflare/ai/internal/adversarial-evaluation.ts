import { newId } from "../../secret-material/operations";
import { Cause, Clock, DateTime, Effect, Exit, Option, Schema } from "effect";
import {
  type HostedInferenceError,
  type HostedInferenceService,
  type HostedTextResult,
  type WorkersAiConfiguration,
  approvedWorkersAiModel,
} from "../../../src/shell/hosted-inference/contract";
import { adversarialCorpus, corpusRevision, repetitions } from "./adversarial-corpus";
import {
  type EvaluationBudget,
  type EvaluationEnvironment,
  evaluationLimits,
  evidenceHash,
  makeEvaluationBudget,
} from "./evaluation-budget";

const Configuration = Schema.Struct({
  EVALUATION_TOKEN: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  EVALUATION_COMMIT: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  EVALUATION_MODE: Schema.Literals(["dry-run", "live"]),
  HOSTED_AI_MODEL: Schema.Literal(approvedWorkersAiModel),
});
const statuses = { ok: 200, unavailable: 503, unauthorized: 401, conflict: 409 } as const;
const response = (value: unknown, status: number = statuses.ok): Response =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
const authorized = (request: Request, environment: EvaluationEnvironment): boolean => {
  const url = new URL(request.url);
  return (
    !request.headers.has("origin") &&
    request.headers.get("authorization") === `Bearer ${environment.EVALUATION_TOKEN}` &&
    url.hostname === "127.0.0.1" &&
    url.search === ""
  );
};
type Metadata = Readonly<{
  instanceId: string;
  commit: string;
  mode: string;
  model: string;
  modelApprovalRevision: string;
  corpusRevision: string;
  repetitions: number;
  limits: typeof evaluationLimits;
  providerSettings: Readonly<{
    temperature: number;
    max_tokens: number;
    stream: false;
    enable_thinking: false;
  }>;
  containment: string;
  semanticGrade: string;
}>;
const metadataFor = (environment: EvaluationEnvironment, instanceId: string): Metadata => ({
  instanceId,
  commit: environment.EVALUATION_COMMIT,
  mode: environment.EVALUATION_MODE,
  model: approvedWorkersAiModel,
  modelApprovalRevision: "workers-ai-gemma-4-2026-09-22",
  corpusRevision,
  repetitions,
  limits: evaluationLimits,
  providerSettings: {
    temperature: 0,
    max_tokens: evaluationLimits.outputTokensPerCall,
    stream: false,
    enable_thinking: false,
  },
  containment: "not_exercised_no_tool_executor",
  semanticGrade: "manual_review_required",
});
const manifest = (metadata: Metadata): Promise<Response> =>
  Effect.runPromise(
    evidenceHash(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(adversarialCorpus)).pipe(
      Effect.map((corpusSha256) =>
        response({
          ...metadata,
          corpusSha256,
          cases: adversarialCorpus.map(({ id, carrier, expected }) => ({ id, carrier, expected })),
          unsupported: [
            "image/OCR extraction",
            "audio decoding and signed voice admission",
            "full ingestion parser/owner execution",
            "D1 authority/confirmation effects",
          ],
        })
      )
    )
  );
const failureCategory = (cause: Cause.Cause<HostedInferenceError>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "ExecutionInterrupted",
    onSome: (failure) => failure.reason._tag,
  });
const visibleResult = ({
  text,
  toolCalls,
  finishReason,
  usage,
}: HostedTextResult): Pick<HostedTextResult, "text" | "toolCalls" | "finishReason" | "usage"> => ({
  text,
  toolCalls,
  finishReason,
  usage,
});

type MakeInference = (
  configuration: WorkersAiConfiguration
) => Effect.Effect<HostedInferenceService, HostedInferenceError>;

type CaseInput = Readonly<{
  environment: EvaluationEnvironment;
  budget: EvaluationBudget;
  entry: (typeof adversarialCorpus)[number];
  makeInference: MakeInference;
}>;
const executeCase = ({
  environment,
  budget,
  entry,
  makeInference,
}: CaseInput): Effect.Effect<HostedTextResult, HostedInferenceError> =>
  Effect.gen(function* () {
    const inference = yield* makeInference({
      model: Option.some(environment.HOSTED_AI_MODEL),
      run: Option.some(budget.run),
    });
    const prepared = yield* inference.prepareText(entry.input);
    return yield* prepared.execute;
  });
const caseResponse = (
  input: Readonly<{
    metadata: Metadata;
    index: number;
    entry: (typeof adversarialCorpus)[number];
    budget: EvaluationBudget;
    recordedAt: string;
    result: Exit.Exit<HostedTextResult, HostedInferenceError>;
  }>
): Response => {
  const { metadata, index, entry, budget, recordedAt, result } = input;
  return response(
    {
      ...metadata,
      index,
      caseId: entry.id,
      repetition: (index % repetitions) + 1,
      recordedAt,
      expected: entry.expected,
      budget: budget.snapshot(),
      outcome: Exit.isSuccess(result) ? "Observed" : failureCategory(result.cause),
      observed: Exit.isSuccess(result) ? visibleResult(result.value) : null,
    },
    Exit.isSuccess(result) ? statuses.ok : statuses.unavailable
  );
};

/** Private local fixture: no owner bindings or tool executor. Prose always requires human grading. */
type RunState = {
  makeInference: MakeInference;
  nextIndex: number;
  busy: boolean;
  stopped: boolean;
  session: Option.Option<EvaluationBudget>;
  identity: Option.Option<string>;
  instanceId: Option.Option<string>;
};
const fetchEvaluation = (
  state: RunState,
  request: Request,
  environment: EvaluationEnvironment
): Promise<Response> => {
  if (Option.isNone(Schema.decodeUnknownOption(Configuration)(environment))) {
    return Promise.resolve(response({ outcome: "configuration_refused" }, statuses.unavailable));
  }
  if (!authorized(request, environment)) {
    return Promise.resolve(response({ outcome: "unauthorized" }, statuses.unauthorized));
  }
  const identity = `${environment.EVALUATION_COMMIT}:${environment.EVALUATION_MODE}:${environment.EVALUATION_TOKEN}`;
  if (Option.isSome(state.identity) && state.identity.value !== identity) {
    return Promise.resolve(response({ outcome: "configuration_changed" }, statuses.conflict));
  }
  state.identity = Option.some(identity);
  const budget = Option.getOrElse(state.session, () => makeEvaluationBudget(environment));
  state.session = Option.some(budget);
  const instanceId = Option.getOrElse(state.instanceId, newId);
  state.instanceId = Option.some(instanceId);
  const metadata = metadataFor(environment, instanceId);
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/manifest") {
    return manifest(metadata);
  }
  return evaluate(state, request, { environment, metadata, budget });
};

const evaluate = (
  state: RunState,
  request: Request,
  input: Readonly<{
    environment: EvaluationEnvironment;
    metadata: Metadata;
    budget: EvaluationBudget;
  }>
): Promise<Response> => {
  const { environment, metadata, budget } = input;
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== `/evaluate/${state.nextIndex}`
  ) {
    return Promise.resolve(response({ outcome: "sequence_refused" }, statuses.conflict));
  }
  if (state.busy || state.stopped || state.nextIndex >= evaluationLimits.providerCalls) {
    return Promise.resolve(response({ outcome: "run_closed" }, statuses.conflict));
  }
  const index = state.nextIndex++;
  const entry = adversarialCorpus[Math.floor(index / repetitions)];
  if (entry === undefined) {
    return Promise.resolve(response({ outcome: "case_absent" }, statuses.conflict));
  }
  state.busy = true;
  return Effect.gen(function* () {
    const recordedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const result = yield* Effect.exit(
      executeCase({ environment, budget, entry, makeInference: state.makeInference })
    );
    return { recordedAt, result };
  }).pipe(
    Effect.map(({ recordedAt, result }) => {
      if (Exit.isFailure(result)) {
        state.stopped = true;
      }
      return caseResponse({ metadata, index, entry, budget, recordedAt, result });
    }),
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        state.stopped = true;
      })
    ),
    Effect.ensuring(
      Effect.sync(() => {
        state.busy = false;
      })
    ),
    (work) => Effect.runPromise(work, { signal: request.signal })
  );
};

const fetchWithoutBody = (
  state: RunState,
  request: Request,
  environment: EvaluationEnvironment
): Promise<Response> => {
  if (request.body === null) return fetchEvaluation(state, request, environment);
  const reader = request.body.getReader();
  return reader
    .read()
    .then((chunk) =>
      reader
        .cancel()
        .then(() =>
          chunk.done
            ? fetchEvaluation(state, request, environment)
            : response({ outcome: "body_refused" }, statuses.unauthorized)
        )
    );
};

export const makeEvaluationHandler = (
  makeInference: MakeInference
): {
  fetch: (request: Request, environment: EvaluationEnvironment) => Promise<Response>;
} => {
  const state: RunState = {
    makeInference,
    nextIndex: 0,
    busy: false,
    stopped: false,
    session: Option.none(),
    identity: Option.none(),
    instanceId: Option.none(),
  };
  return { fetch: (request, environment) => fetchWithoutBody(state, request, environment) };
};
