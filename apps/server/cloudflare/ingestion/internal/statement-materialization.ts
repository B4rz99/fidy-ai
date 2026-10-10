import { Clock, Data, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { ParsedStatementRow } from "../../../src/core/ingestion/contract";
import { type ParsedStatement, statementParserLimits } from "../../../src/shell/ingestion/contract";
import {
  maximumMaterializedHeaderBytes,
  maximumMaterializedStatementBytes,
  statementChunkSize,
} from "./statement-processing-limits";
import { materializedHeaderBytes, materializedStatementBytes } from "./statement-review-budget";

const bytesPerKibibyte = 1024;
const fragmentKibicharacters = 128;
const maximumMaterializedBytes = maximumMaterializedStatementBytes;
const fragmentCharacters = fragmentKibicharacters * bytesPerKibibyte;
const maximumParts = 1024;
const maximumHeaderBytes = maximumMaterializedHeaderBytes;
const writeBatchSize = 8;
const highSurrogateStart = 0xd800;
const highSurrogateEnd = 0xdbff;
const headersCodec = Schema.fromJsonString(Schema.NonEmptyArray(Schema.String));
const rowsCodec = Schema.fromJsonString(Schema.toCodecJson(Schema.Array(ParsedStatementRow)));
const digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Manifest = Schema.Struct({
  source_sha256: digest,
  parser_revision: Schema.String,
  source_format: Schema.Literals(["csv", "xlsx"]),
  expires_at_ms: Schema.Int,
  headers_json: Schema.String.check(Schema.isMaxLength(maximumHeaderBytes)),
  row_count: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: statementParserLimits.maximumRows })
  ),
  part_count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumParts })),
  byte_length: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: maximumMaterializedBytes })
  ),
  rebuilds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  state: Schema.Literals(["building", "ready"]),
});
type Manifest = typeof Manifest.Type;
const Part = Schema.Struct({
  part_index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maximumParts - 1 })),
  body: Schema.String.check(Schema.isMaxLength(fragmentCharacters)),
  sha256: digest,
});
type MaterializationIdentity = Readonly<{
  DB: D1Database;
  userId: string;
  submissionId: string;
  sourceHash: string;
  parserRevision: string;
  sourceFormat: "csv" | "xlsx";
  expiresAtMs: number;
}>;
type MaterializedChunk = ParsedStatement & Readonly<{ totalRows: number }>;
type EncodedPart = Readonly<{ chunk: number; part: number; body: string; hash: string }>;
type EncodedMaterial = Readonly<{
  parts: ReadonlyArray<EncodedPart>;
  byteLength: number;
  headersJson: string;
}>;
export class StatementMaterializationFailed extends Data.TaggedError(
  "StatementMaterializationFailed"
)<{
  readonly reason: "resource-limit" | "malformed-file";
}> {}
export class StatementMaterializationUnavailable extends Data.TaggedError(
  "StatementMaterializationUnavailable"
) {}
type Failure = StatementMaterializationFailed | StatementMaterializationUnavailable;
type BoundaryFailure = Failure | Schema.SchemaError;
const failed = (): StatementMaterializationFailed =>
  new StatementMaterializationFailed({ reason: "malformed-file" });
const normalize = (error: BoundaryFailure): Failure =>
  error instanceof StatementMaterializationFailed ||
  error instanceof StatementMaterializationUnavailable
    ? error
    : failed();
const foreign = <A>(run: () => Promise<A>): Effect.Effect<A, StatementMaterializationUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new StatementMaterializationUnavailable() });
const checksum = (text: string): Effect.Effect<string, StatementMaterializationUnavailable> =>
  foreign(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((value) => Hex.encode(new Uint8Array(value)))
  );
const manifest = (
  input: MaterializationIdentity
): Effect.Effect<Option.Option<Manifest>, BoundaryFailure> =>
  foreign(() =>
    input.DB.prepare(`SELECT source_sha256,parser_revision,source_format,expires_at_ms,
    headers_json,row_count,part_count,byte_length,state,rebuilds FROM statement_materializations
    WHERE submission_id=? AND user_id=?`)
      .bind(input.submissionId, input.userId)
      .first()
  ).pipe(
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeedNone
        : Schema.decodeUnknownEffect(Manifest)(raw).pipe(Effect.asSome)
    )
  );
const publish = (
  input: MaterializationIdentity,
  current: number
): Effect.Effect<boolean, Failure> =>
  foreign(() =>
    input.DB.prepare(`UPDATE statement_materializations SET state='ready'
    WHERE submission_id=? AND user_id=? AND state='building'
    AND part_count=(SELECT count(*) FROM statement_materialization_parts WHERE submission_id=?)
    AND byte_length=(SELECT sum(length(CAST(body AS BLOB))) FROM statement_materialization_parts WHERE submission_id=?)
    AND EXISTS(SELECT 1 FROM statement_submissions WHERE id=? AND user_id=? AND status IN ('queued','processing')
      AND retention_expires_at_ms>?) RETURNING submission_id`)
      .bind(
        input.submissionId,
        input.userId,
        input.submissionId,
        input.submissionId,
        input.submissionId,
        input.userId,
        current
      )
      .all()
  ).pipe(Effect.map((result) => result.results.length === 1));
const recoverBuilding = (input: MaterializationIdentity): Effect.Effect<boolean, Failure> =>
  Effect.gen(function* () {
    if (yield* publish(input, yield* Clock.currentTimeMillis)) {
      return true;
    }
    const reset = yield* foreign(() =>
      input.DB.prepare(`UPDATE statement_materializations SET rebuilds=1
      WHERE submission_id=? AND user_id=? AND state='building' AND rebuilds=0 RETURNING submission_id`)
        .bind(input.submissionId, input.userId)
        .all()
    );
    if (reset.results.length === 0) {
      return yield* new StatementMaterializationUnavailable();
    }
    yield* foreign(() =>
      input.DB.prepare(`DELETE FROM statement_materialization_parts WHERE submission_id=?`)
        .bind(input.submissionId)
        .run()
    );
    return false;
  });
const matchesIdentity = (input: MaterializationIdentity, value: Manifest): boolean =>
  value.source_sha256 === input.sourceHash &&
  value.parser_revision === input.parserRevision &&
  value.source_format === input.sourceFormat &&
  value.expires_at_ms === input.expiresAtMs;
const validateParts = (
  parts: ReadonlyArray<typeof Part.Type>,
  budget: number
): Effect.Effect<string, Failure> =>
  Effect.gen(function* () {
    if (parts.length === 0) {
      return yield* failed();
    }
    let bytes = 0;
    for (const [index, part] of parts.entries()) {
      bytes += new TextEncoder().encode(part.body).byteLength;
      if (part.part_index !== index || bytes > budget) {
        return yield* failed();
      }
      if ((yield* checksum(part.body)) !== part.sha256) {
        return yield* failed();
      }
    }
    return parts.map((part) => part.body).join("");
  });
const readRows = (
  input: MaterializationIdentity,
  offset: number,
  value: Manifest
): Effect.Effect<ReadonlyArray<ParsedStatementRow>, BoundaryFailure> =>
  Effect.gen(function* () {
    const chunkIndex = Math.floor(offset / statementChunkSize);
    const response = yield* foreign(() =>
      input.DB.prepare(`SELECT p.part_index,p.body,p.sha256
      FROM statement_materialization_parts p JOIN statement_materializations m ON m.submission_id=p.submission_id
      WHERE p.submission_id=? AND m.user_id=? AND m.state='ready' AND p.chunk_index=?
      ORDER BY p.part_index LIMIT ?`)
        .bind(input.submissionId, input.userId, chunkIndex, maximumParts)
        .all()
    );
    const parts = yield* Schema.decodeUnknownEffect(Schema.Array(Part))(response.results);
    const text = yield* validateParts(parts, value.byte_length);
    const rows = yield* Schema.decodeEffect(rowsCodec)(text);
    const expected = Math.min(
      statementChunkSize,
      value.row_count - chunkIndex * statementChunkSize
    );
    const numbered = rows.every(
      (row, index) => row.recordNumber === chunkIndex * statementChunkSize + index + 1
    );
    if (rows.length !== expected || !numbered) {
      return yield* failed();
    }
    return rows.slice(offset % statementChunkSize);
  });

/** Loads at most one owned chunk at the durable cursor. Refuses substituted data and permits one bounded rebuild of interrupted publication. */
export const readMaterializedChunk = (
  input: MaterializationIdentity & Readonly<{ offset: number }>
): Effect.Effect<Option.Option<MaterializedChunk>, Failure> =>
  Effect.gen(function* () {
    const found = yield* manifest(input);
    if (Option.isNone(found)) {
      return Option.none();
    }
    const value = found.value;
    if (!matchesIdentity(input, value) || input.offset > value.row_count) {
      return yield* failed();
    }
    if (value.state === "building" && !(yield* recoverBuilding(input))) {
      return Option.none();
    }
    const headers = yield* Schema.decodeEffect(headersCodec)(value.headers_json);
    const rows =
      input.offset === value.row_count ? [] : yield* readRows(input, input.offset, value);
    return Option.some({
      sourceFormat: value.source_format,
      headers,
      rows,
      totalRows: value.row_count,
    });
  }).pipe(Effect.mapError(normalize));

const splitChunk = (
  text: string,
  chunk: number
): Effect.Effect<ReadonlyArray<EncodedPart>, Failure> =>
  Effect.gen(function* () {
    const parts: Array<EncodedPart> = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + fragmentCharacters, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= highSurrogateStart && last <= highSurrogateEnd) {
        end -= 1;
      }
      const body = text.slice(start, end);
      parts.push({ chunk, part: parts.length, body, hash: yield* checksum(body) });
      start = end;
    }
    return parts;
  });
const encodeMaterial = (parsed: ParsedStatement): Effect.Effect<EncodedMaterial, BoundaryFailure> =>
  Effect.gen(function* () {
    const parts: Array<EncodedPart> = [];
    let byteLength = 0;
    for (let offset = 0; offset < parsed.rows.length; offset += statementChunkSize) {
      const chunk = parsed.rows.slice(offset, offset + statementChunkSize);
      byteLength += materializedStatementBytes(chunk);
      if (byteLength > maximumMaterializedBytes) {
        return yield* new StatementMaterializationFailed({ reason: "resource-limit" });
      }
      const text = yield* Schema.encodeEffect(rowsCodec)(chunk);
      parts.push(...(yield* splitChunk(text, Math.floor(offset / statementChunkSize))));
    }
    if (parts.length > maximumParts) {
      return yield* new StatementMaterializationFailed({ reason: "resource-limit" });
    }
    if (materializedHeaderBytes(parsed.headers) > maximumHeaderBytes) {
      return yield* new StatementMaterializationFailed({ reason: "resource-limit" });
    }
    const headersJson = yield* Schema.encodeEffect(headersCodec)(parsed.headers);
    return { parts, byteLength, headersJson };
  });
const prepareManifest = (
  input: MaterializationIdentity,
  parsed: ParsedStatement,
  encoded: EncodedMaterial
): Effect.Effect<void, BoundaryFailure> =>
  Effect.gen(function* () {
    const found = yield* manifest(input);
    if (Option.isSome(found)) {
      const value = found.value;
      if (
        !matchesIdentity(input, value) ||
        value.state !== "building" ||
        value.headers_json !== encoded.headersJson ||
        value.row_count !== parsed.rows.length ||
        value.part_count !== encoded.parts.length ||
        value.byte_length !== encoded.byteLength
      ) {
        return yield* failed();
      }
      return;
    }
    yield* foreign(() =>
      input.DB.prepare(`INSERT INTO statement_materializations
      (submission_id,user_id,source_sha256,parser_revision,source_format,expires_at_ms,headers_json,row_count,part_count,byte_length,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,'building')`)
        .bind(
          input.submissionId,
          input.userId,
          input.sourceHash,
          input.parserRevision,
          input.sourceFormat,
          input.expiresAtMs,
          encoded.headersJson,
          parsed.rows.length,
          encoded.parts.length,
          encoded.byteLength
        )
        .run()
    );
  });
const writeParts = (
  input: MaterializationIdentity,
  parts: ReadonlyArray<EncodedPart>
): Effect.Effect<void, Failure> =>
  Effect.gen(function* () {
    for (let offset = 0; offset < parts.length; offset += writeBatchSize) {
      yield* foreign(() =>
        input.DB.batch(
          parts
            .slice(offset, offset + writeBatchSize)
            .map((part) =>
              input.DB.prepare(
                `INSERT INTO statement_materialization_parts(submission_id,chunk_index,part_index,body,sha256) VALUES (?,?,?,?,?)`
              ).bind(input.submissionId, part.chunk, part.part, part.body, part.hash)
            )
        )
      );
    }
  });
/** Retains at most 16 MiB of derived rows for the original source purpose/deadline. Only complete publication may drive captures. Requires the User coordinator. */
export const materializeStatement = (
  input: MaterializationIdentity & Readonly<{ parsed: ParsedStatement }>
): Effect.Effect<void, Failure> =>
  Effect.gen(function* () {
    const encoded = yield* encodeMaterial(input.parsed);
    yield* prepareManifest(input, input.parsed, encoded);
    yield* writeParts(input, encoded.parts);
    if (!(yield* publish(input, yield* Clock.currentTimeMillis))) {
      return yield* failed();
    }
  }).pipe(Effect.mapError(normalize));
