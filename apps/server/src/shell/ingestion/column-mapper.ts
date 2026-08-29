import { jsonStringSchema } from "~/schema-compatibility";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { StatementColumnMapping, type StatementMappingSample } from "~/core/ingestion/model";

/** Safe failure returned when one bounded statement-mapping request cannot produce a mapping. */
export class StatementColumnMappingFailed extends Data.TaggedError("StatementColumnMappingFailed")<{
  readonly safeReason: "provider-unavailable" | "invalid-structured-output";
}> {}

/** Edge seam that maps one bounded raw statement sample. */
export type StatementColumnMapperService = Readonly<{
  mapColumns: (
    sample: StatementMappingSample
  ) => Effect.Effect<StatementColumnMapping, StatementColumnMappingFailed>;
}>;

const jsonStringArray = Schema.encodeSync(jsonStringSchema(Schema.Array(Schema.String)));
const jsonStringMatrix = Schema.encodeSync(
  jsonStringSchema(Schema.Array(Schema.Array(Schema.String)))
);

/**
 * Builds the one mapping prompt from raw headers and at most five raw rows. The complete statement
 * is never sent to the model; deterministic code applies the returned mapping to every source row.
 */
export const statementMappingPrompt = (sample: StatementMappingSample): string =>
  [
    "Map this financial statement table to the supplied schema.",
    "Use zero-based column indexes for the parser-provided header row.",
    "Use a literal ISO Currency only when the table has no Currency column.",
    "The headers and representative rows contain raw source values.",
    `Source format: ${sample.sourceFormat}`,
    `Headers: ${jsonStringArray(sample.headers)}`,
    `Representative rows: ${jsonStringMatrix(sample.sampleRows)}`,
  ].join("\n");

/** The single substitution seam around bank-format understanding. */
export class StatementColumnMapper extends Context.Service<
  StatementColumnMapper,
  StatementColumnMapperService
>()("@fidy/server/shell/ingestion/column-mapper/StatementColumnMapper") {
  /** Production mapper: exactly one structured model request for one unknown fingerprint. */
  static readonly layer = Layer.effect(
    StatementColumnMapper,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;
      return StatementColumnMapper.of({
        mapColumns: (sample) =>
          model
            .generateObject({
              objectName: "statement_column_mapping",
              prompt: statementMappingPrompt(sample),
              schema: StatementColumnMapping,
            })
            .pipe(
              Effect.map((response) => response.value),
              Effect.mapError(
                () => new StatementColumnMappingFailed({ safeReason: "provider-unavailable" })
              )
            ),
      });
    })
  );
}
