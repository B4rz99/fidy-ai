import { Context, Effect, Exit, Layer, Stream } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { StatementColumnMapper, statementMappingPrompt } from "./column-mapper";

describe("statement mapping prompt", () => {
  it("sends the bounded raw sample needed to understand an unknown format", () => {
    const prompt = statementMappingPrompt({
      sourceFormat: "csv",
      headers: ["Date - Jane Doe account 998877", "Amount", "Description"],
      sampleRows: [["2024-07-03", "12345.67", "Private hospital payment"]],
    });

    expect(prompt).toContain("Source format: csv");
    expect(prompt).toContain('Headers: ["Date - Jane Doe account 998877","Amount","Description"]');
    expect(prompt).toContain(
      'Representative rows: [["2024-07-03","12345.67","Private hospital payment"]]'
    );
  });

  it.effect("maps model failures to a safe adapter error", () => {
    const modelFailure = AiError.AiError.make({
      module: "StatementColumnMapperTest",
      method: "generateObject",
      reason: AiError.InternalProviderError.make({ description: "scripted provider failure" }),
    });
    const FailingModel = Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => Effect.fail(modelFailure),
        streamText: () => Stream.fail(modelFailure),
      })
    );
    const MapperTestLive = StatementColumnMapper.layer.pipe(Layer.provide(FailingModel));
    return Effect.gen(function* () {
      const context = yield* Effect.scoped(Layer.build(MapperTestLive));
      const mapper = Context.get(context, StatementColumnMapper);
      const input = {
        sourceFormat: "csv",
        headers: ["Date", "Amount"],
        sampleRows: [["2026-02-05", "25"]],
      } as const;
      const first = yield* Effect.exit(mapper.mapColumns(input));
      const second = yield* Effect.exit(mapper.mapColumns(input));
      expect(Exit.isFailure(first)).toBe(true);
      expect(Exit.isFailure(second)).toBe(true);
    });
  });
});
