import { Context, Effect, Exit, Layer, Stream } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { StatementColumnMapper, statementMappingPrompt } from "./column-mapper";

describe("statement mapping prompt", () => {
  it("projects representative cells without sending source financial values", () => {
    const prompt = statementMappingPrompt({
      sourceFormat: "csv",
      headers: [
        "Date - Jane Doe account 998877",
        "Amount",
        "Description",
        "Direction",
        "Currency",
        "998877",
      ],
      sampleRows: [["2024-07-03", "12345.67", "Private hospital payment", "DEBIT", "COP", ""]],
    });

    expect(prompt).not.toContain("Jane Doe");
    expect(prompt).not.toContain("998877");
    expect(prompt).not.toContain("2024-07-03");
    expect(prompt).not.toContain("12345.67");
    expect(prompt).not.toContain("Private hospital payment");
    expect(prompt).toContain('Header classes: ["date","amount"');
    expect(prompt).toContain("<date:yyyy-mm-dd>");
    expect(prompt).toContain("<number>");
    expect(prompt).toContain("<text>");
    expect(prompt).toContain("<direction:debit>");
    expect(prompt).toContain("<currency:COP>");
    expect(prompt).toContain("<column:5>");
    expect(prompt).toContain("<blank>");
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
