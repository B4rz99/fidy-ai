import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  hostedInferenceEvaluationMetadata,
  hostedInferenceEvaluationSourcePath,
} from "./provider-evaluation-runtime";

const serverRoot = new URL("../../../", import.meta.url);

it.effect("attests the provider-control source that defines the evaluated identifiers", () =>
  Effect.gen(function* () {
    const sourceFile = Bun.file(new URL(hostedInferenceEvaluationSourcePath, serverRoot));
    expect(yield* Effect.promise(() => sourceFile.exists())).toBe(true);
    const source = yield* Effect.promise(() => sourceFile.text());

    expect(source).toContain("hostedInferenceProviderMetadata");
    expect(source).toContain("HostedAgentGenerationConfig");

    expect(hostedInferenceEvaluationMetadata.provider).toBe("openai");
    expect(hostedInferenceEvaluationMetadata.requestedModel).not.toBe("");
    expect(Number.isFinite(hostedInferenceEvaluationMetadata.temperature)).toBe(true);
  })
);
