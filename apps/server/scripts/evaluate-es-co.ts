#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Config, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AgentService } from "~/shell/agent/agent-service";
import { OpenAiHostedInferenceLive, OpenAiLanguageModelLive } from "~/shell/agent/openai";
import { StatementColumnMapper } from "~/shell/ingestion/column-mapper";
import { NotificationEmailExtractor } from "~/shell/ingestion/email-extractor";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { ApiHarness } from "~/shell/testing/api-harness";
import { EvaluationFailure, RunPlan } from "~/shell/testing/evaluation/model";
import { requestBudgetLayer } from "~/shell/testing/evaluation/request-budget";
import { scriptedInference } from "~/shell/testing/evaluation/safety";
import { evaluationPolicy, runEvaluation } from "~/shell/testing/evaluation/runner";

const mode = Schema.decodeUnknownSync(RunPlan.fields.mode)(Bun.argv[2] ?? "safety");
const policy = evaluationPolicy(mode);
const plan = policy.plan;

const program = Effect.gen(function* () {
  const origin = yield* Config.string("OPENAI_API_URL").pipe(
    Config.withDefault("https://api.openai.com/v1")
  );
  if (policy.startupValidation && origin !== "https://api.openai.com/v1") {
    return yield* new EvaluationFailure({ reason: "unsafe-environment" });
  }
  if (policy.requiresApproval) {
    const approval = yield* Config.string("FIDY_EVALUATION_APPROVE_FULL");
    if (approval !== "synthetic-only") {
      return yield* new EvaluationFailure({ reason: "unsafe-environment" });
    }
  }
  const result = yield* runEvaluation(mode);
  process.stdout.write(
    `Evaluation ${result.report.conclusion}: ${result.report.results.length} case runs, ` +
      `${result.report.providerRequests} provider requests. Report: ${result.path}\n`
  );
});

const Budget = requestBudgetLayer(plan.maximumRequests);
const SafetyWork = Layer.mergeAll(
  AgentService.layer.pipe(Layer.provide(scriptedInference([]))),
  Layer.succeed(
    StatementColumnMapper,
    StatementColumnMapper.of({
      mapColumns: () => Effect.die("Statement evaluation is unavailable in safety mode"),
    })
  ),
  Layer.succeed(
    NotificationEmailExtractor,
    NotificationEmailExtractor.of({
      extract: () => Effect.die("Email evaluation is unavailable in safety mode"),
    })
  )
);
const SafetyApp = SafetyWork.pipe(
  Layer.provideMerge(ApiHarness),
  Layer.provideMerge(TelemetryDisabled),
  Layer.provideMerge(Budget)
);
// Capture a provider-only client before the local ApiHarness client enters application scope.
const ProviderHttp = FetchHttpClient.layer.pipe(Layer.provide(Budget));
const HostedInferenceLive = OpenAiHostedInferenceLive.pipe(Layer.provide(ProviderHttp));
const LanguageModelLive = OpenAiLanguageModelLive.pipe(Layer.provide(ProviderHttp));
const ModelWork = Layer.mergeAll(
  AgentService.layer.pipe(Layer.provide(HostedInferenceLive)),
  StatementColumnMapper.layer.pipe(Layer.provide(LanguageModelLive)),
  NotificationEmailExtractor.layer.pipe(Layer.provide(LanguageModelLive))
);
const EvaluationApp = ModelWork.pipe(
  Layer.provideMerge(ApiHarness),
  Layer.provideMerge(TelemetryDisabled),
  Layer.provideMerge(Budget)
);
const EvaluationCommand = Layer.effectDiscard(program).pipe(
  Layer.provide(policy.usesSafetyStack ? SafetyApp : EvaluationApp)
);
const failSafely = (classification: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stderr.write(
      `Evaluation unavailable: bounded synthetic run failed (${classification}).\n`
    );
    process.exitCode = 1;
  });
const command = Effect.scoped(Layer.build(EvaluationCommand)).pipe(
  Effect.catch((failure) =>
    failSafely(failure._tag === "HostedInferenceError" ? failure.reason._tag : failure._tag)
  ),
  Effect.catchCause(() => failSafely("UnexpectedFailure"))
);
BunRuntime.runMain(command, { disableErrorReporting: true });
