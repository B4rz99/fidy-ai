import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { Currency } from "~/core/_shared/money";
import { StatementColumnMapping, type StatementMappingSample } from "~/core/ingestion/model";

/** Safe failure returned when one bounded statement-mapping request cannot produce a mapping. */
export class StatementColumnMappingFailed extends Data.TaggedError("StatementColumnMappingFailed")<{
  readonly safeReason: "provider-unavailable" | "invalid-structured-output";
}> {}

/** Edge seam that maps one bounded, privacy-projected statement sample. */
export type StatementColumnMapperService = Readonly<{
  mapColumns: (
    sample: StatementMappingSample
  ) => Effect.Effect<StatementColumnMapping, StatementColumnMappingFailed>;
}>;

const jsonStringArray = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const jsonStringMatrix = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String)))
);
const directionMarkers = new Set(["credit", "cr", "debit", "dr", "in", "out"]);
const semanticHeaderWords = new Set([
  "amount",
  "balance",
  "counterparty",
  "credit",
  "currency",
  "date",
  "debit",
  "description",
  "details",
  "direction",
  "inflow",
  "memo",
  "merchant",
  "outflow",
  "payee",
  "posted",
  "transaction",
  "type",
  "value",
  "beneficiario",
  "comercio",
  "concepto",
  "credito",
  "debito",
  "descripcion",
  "detalle",
  "fecha",
  "moneda",
  "monto",
  "saldo",
  "tipo",
  "valor",
]);
const isoDate = /^\d{4}-\d{2}-\d{2}$/u;
const numericValue = /^[+-]?(?:\d{1,3}(?:[ ,.']\d{3})+|\d+)(?:[.,]\d+)?$/u;

const projectHeader = (header: string, index: number): string => {
  const words = header
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .match(/[a-z]+/gu);
  const semanticWords = words?.filter((word) => semanticHeaderWords.has(word)) ?? [];
  return semanticWords.length > 0 ? semanticWords.join(" ") : `<column:${index}>`;
};

const projectCell = (cell: string): string => {
  const normalized = cell.trim();
  if (normalized.length === 0) return "<blank>";
  if (isoDate.test(normalized)) return "<date:yyyy-mm-dd>";
  if (numericValue.test(normalized)) return "<number>";
  const lower = normalized.toLowerCase();
  if (directionMarkers.has(lower)) return `<direction:${lower}>`;
  const upper = normalized.toUpperCase();
  if (Option.isSome(Schema.decodeUnknownOption(Currency)(upper))) return `<currency:${upper}>`;
  return "<text>";
};

/** Builds the model prompt from headers and non-sensitive cell classifications only. */
export const statementMappingPrompt = (sample: StatementMappingSample): string =>
  [
    "Map this financial statement table to the supplied schema.",
    "Use zero-based column indexes for the parser-provided header row.",
    "Use a literal ISO Currency only when the table has no Currency column.",
    "Representative cells are privacy-preserving classifications, never source values.",
    `Source format: ${sample.sourceFormat}`,
    `Header classes: ${jsonStringArray(sample.headers.map(projectHeader))}`,
    `Representative cell classes: ${jsonStringMatrix(sample.sampleRows.map((row) => row.map(projectCell)))}`,
  ].join("\n");

/** The single substitution seam around bank-format understanding. */
export class StatementColumnMapper extends Context.Service<
  StatementColumnMapper,
  StatementColumnMapperService
>()("fidy-ai/shell/ingestion/column-mapper/StatementColumnMapper") {
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
