import { Effect, Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeDeterministicHostedInference } from "~/shell/hosted-inference/internal/deterministic";
import {
  OpenAiLanguageModelLive,
  openAiHostedInferenceWithoutStartupValidation,
} from "~/shell/hosted-inference/internal/openai";
import { OutboundHttp } from "~/shell/outbound-http/operations";
import { HostedInference } from "./operations";

const publishLanguageModel = <E, R>(
  implementation: Layer.Layer<LanguageModel.LanguageModel, E, R>
): Layer.Layer<LanguageModel.LanguageModel, E, R> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.map(LanguageModel.LanguageModel, LanguageModel.LanguageModel.of)
  ).pipe(Layer.provide(implementation));

/** Production HostedInference adapter with fail-closed maximum-request startup validation. */
export const HostedInferenceLive = HostedInference.layer;

/** Production structured LanguageModel adapter for bounded ingestion extraction. */
export const StatementLanguageModelLive = publishLanguageModel(OpenAiLanguageModelLive);

/** HostedInference adapter without startup validation for explicit test harness composition. */
export const HostedInferenceWithoutStartupValidation = Layer.effect(
  HostedInference,
  openAiHostedInferenceWithoutStartupValidation
).pipe(Layer.provide(OutboundHttp.openAiLayer));

/** Deterministic model-backed runtime for named cross-module test harnesses. */
export const HostedInferenceDeterministicTest = Layer.effect(
  HostedInference,
  Effect.map(LanguageModel.LanguageModel, makeDeterministicHostedInference)
);
