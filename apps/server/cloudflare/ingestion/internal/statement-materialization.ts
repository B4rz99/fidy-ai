import { Clock, Data, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { ParsedStatementRow } from "../../../src/core/ingestion/contract";
import { type ParsedStatement, statementParserLimits } from "../../../src/shell/ingestion/contract";
import {
  maximumMaterializedHeaderBytes,
  maximumMaterializedStatementBytes,
  maximumStatementSourceParses,
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
const representationRevision = "statement-material-v1";
const highSurrogateStart = 0xd800;
const highSurrogateEnd = 0xdbff;
const headersCodec = Schema.fromJsonString(Schema.NonEmptyArray(Schema.String));
const rowsCodec = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Array(ParsedStatementRow).check(Schema.isMaxLength(statementChunkSize)))
);
const digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Manifest = Schema.Struct({
  source_sha256: digest,
  parts_sha256: digest,
  parser_revision: Schema.String,
  source_format: Schema.Literals(["csv", "xlsx"]),
  representation_revision: Schema.Literal(representationRevision),
  service_market: Schema.NonEmptyString,
  locale: Schema.NonEmptyString,
  time_zone: Schema.NonEmptyString,
  expires_at_ms: Schema.Int,
  headers_json: Schema.String.check(Schema.isMaxLength(maximumHeaderBytes)),
  row_count: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: statementParserLimits.maximumRows })
  ),
  part_count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumParts })),
  byte_length: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: maximumMaterializedBytes })
  ),
  state: Schema.Literals(["building", "ready"]),
});
type Manifest = typeof Manifest.Type;
const Part = Schema.Struct({
  part_index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maximumParts - 1 })),
  body: Schema.String.check(Schema.isMaxLength(fragmentCharacters)),
  sha256: digest,
});
const StoredPart = Schema.Struct({
  ...Part.fields,
  chunk_index: Schema.Int.check(
    Schema.isBetween({
      minimum: 0,
      maximum: Math.ceil(statementParserLimits.maximumRows / statementChunkSize) - 1,
    })
  ),
});
type MaterializationIdentity = Readonly<{
  DB: D1Database;
  userId: string;
  submissionId: string;
  sourceHash: string;
  parserRevision: string;
  sourceFormat: "csv" | "xlsx";
  expiresAtMs: number;
  serviceMarket: string;
  locale: string;
  timeZone: string;
}>;
type MaterializedChunk = ParsedStatement & Readonly<{ totalRows: number }>;
type EncodedPart = Readonly<{ chunk: number; part: number; body: string; hash: string }>;
type EncodedMaterial = Readonly<{
  parts: ReadonlyArray<EncodedPart>;
  byteLength: number;
  headersJson: string;
  partsHash: string;
}>;
type PartIdentity = Pick<EncodedPart, "chunk" | "part" | "hash">;
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
const partsChecksum = (
  parts: ReadonlyArray<PartIdentity>
): Effect.Effect<string, StatementMaterializationUnavailable> =>
  checksum(JSON.stringify(parts.map(({ chunk, part, hash }) => ({ chunk, part, hash }))));
const findManifest = (
  input: MaterializationIdentity
): Effect.Effect<Option.Option<Manifest>, BoundaryFailure> =>
  foreign(() =>
    input.DB.prepare(`SELECT source_sha256,parts_sha256,parser_revision,source_format,expires_at_ms,
    representation_revision,service_market,locale,time_zone,
    headers_json,row_count,part_count,byte_length,state FROM statement_materializations
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
const verifiedPartIdentity = (part: typeof StoredPart.Type): Effect.Effect<PartIdentity, Failure> =>
  checksum(part.body).pipe(
    Effect.flatMap((hash) =>
      hash === part.sha256
        ? Effect.succeed({ chunk: part.chunk_index, part: part.part_index, hash })
        : Effect.fail(failed())
    )
  );
const verifyPublication = (
  input: MaterializationIdentity,
  manifest: Manifest
): Effect.Effect<boolean, BoundaryFailure> =>
  Effect.gen(function* () {
    const raw = yield* foreign(() =>
      input.DB.prepare(`SELECT count(*) AS parts, coalesce(sum(length(CAST(p.body AS BLOB))),0) AS bytes
        FROM statement_materialization_parts p JOIN statement_materializations m ON m.submission_id=p.submission_id
        WHERE p.submission_id=? AND m.user_id=? AND m.state='building'`)
        .bind(input.submissionId, input.userId)
        .first()
    );
    const stored = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ parts: Schema.Int, bytes: Schema.Int })
    )(raw);
    if (stored.parts < manifest.part_count) {
      return false;
    }
    if (stored.parts !== manifest.part_count || stored.bytes !== manifest.byte_length) {
      return yield* failed();
    }
    const identities: Array<PartIdentity> = [];
    let cursorChunk = -1;
    let cursorPart = -1;
    for (let offset = 0; offset < manifest.part_count; offset += writeBatchSize) {
      const response = yield* foreign(() =>
        input.DB.prepare(`SELECT p.chunk_index,p.part_index,p.body,p.sha256 FROM statement_materialization_parts p
          JOIN statement_materializations m ON m.submission_id=p.submission_id
          WHERE p.submission_id=? AND m.user_id=? AND m.state='building'
          AND (p.chunk_index,p.part_index)>(?,?)
          ORDER BY p.chunk_index,p.part_index LIMIT ?`)
          .bind(input.submissionId, input.userId, cursorChunk, cursorPart, writeBatchSize)
          .all()
      );
      const parts = yield* Schema.decodeUnknownEffect(Schema.Array(StoredPart))(response.results);
      if (parts.length !== Math.min(writeBatchSize, manifest.part_count - offset)) {
        return yield* failed();
      }
      for (const part of parts) {
        identities.push(yield* verifiedPartIdentity(part));
        cursorChunk = part.chunk_index;
        cursorPart = part.part_index;
      }
    }
    if ((yield* partsChecksum(identities)) !== manifest.parts_sha256) return yield* failed();
    return true;
  });
const recoverBuilding = (
  input: MaterializationIdentity,
  manifest: Manifest
): Effect.Effect<boolean, BoundaryFailure> =>
  Effect.gen(function* () {
    if (
      (yield* verifyPublication(input, manifest)) &&
      (yield* publish(input, yield* Clock.currentTimeMillis))
    ) {
      return true;
    }
    // Idempotent cleanup: lost responses and failed deletes consume no parse reservation.
    yield* foreign(() =>
      input.DB.prepare(`DELETE FROM statement_materialization_parts WHERE submission_id=?
        AND EXISTS(SELECT 1 FROM statement_materializations WHERE submission_id=? AND user_id=? AND state='building')`)
        .bind(input.submissionId, input.submissionId, input.userId)
        .run()
    );
    return false;
  });
const matchesIdentity = (input: MaterializationIdentity, value: Manifest): boolean =>
  value.source_sha256 === input.sourceHash &&
  value.parser_revision === input.parserRevision &&
  value.source_format === input.sourceFormat &&
  value.service_market === input.serviceMarket &&
  value.locale === input.locale &&
  value.time_zone === input.timeZone &&
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
      AND (SELECT sum(length(CAST(body AS BLOB))) FROM statement_materialization_parts
        WHERE submission_id=? AND chunk_index=?)<=?
      ORDER BY p.part_index LIMIT ?`)
        .bind(
          input.submissionId,
          input.userId,
          chunkIndex,
          input.submissionId,
          chunkIndex,
          value.byte_length,
          maximumParts
        )
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

/** Loads at most one owned chunk at the durable cursor. Refuses substituted data and recovers interrupted publication within the durable source-parse budget. */
export const findMaterializedChunk = (
  input: MaterializationIdentity & Readonly<{ offset: number }>
): Effect.Effect<Option.Option<MaterializedChunk>, Failure> =>
  Effect.gen(function* () {
    const found = yield* findManifest(input);
    if (Option.isNone(found)) {
      return Option.none();
    }
    const value = found.value;
    if (!matchesIdentity(input, value) || input.offset > value.row_count) {
      return yield* failed();
    }
    if (value.state === "building" && !(yield* recoverBuilding(input, value))) {
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
    return { parts, byteLength, headersJson, partsHash: yield* partsChecksum(parts) };
  });
const matchesEncodedMaterial = (
  value: Manifest,
  parsed: ParsedStatement,
  encoded: EncodedMaterial
): boolean =>
  value.state === "building" &&
  value.headers_json === encoded.headersJson &&
  value.row_count === parsed.rows.length &&
  value.part_count === encoded.parts.length &&
  value.byte_length === encoded.byteLength &&
  value.parts_sha256 === encoded.partsHash;
const prepareManifest = (
  input: MaterializationIdentity,
  parsed: ParsedStatement,
  encoded: EncodedMaterial
): Effect.Effect<void, BoundaryFailure> =>
  Effect.gen(function* () {
    const found = yield* findManifest(input);
    if (Option.isSome(found)) {
      const value = found.value;
      if (!matchesIdentity(input, value) || !matchesEncodedMaterial(value, parsed, encoded)) {
        return yield* failed();
      }
      return;
    }
    yield* foreign(() =>
      input.DB.prepare(`INSERT INTO statement_materializations
      (submission_id,user_id,source_sha256,parser_revision,source_format,expires_at_ms,headers_json,row_count,part_count,byte_length,
        representation_revision,service_market,locale,time_zone,parts_sha256,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'building')`)
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
          encoded.byteLength,
          representationRevision,
          input.serviceMarket,
          input.locale,
          input.timeZone,
          encoded.partsHash
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
/** Reserve before expensive source reads. Ambiguous acknowledgements consume a slot, while idempotent cache cleanup remains independently retryable. */
export const reserveStatementSourceParse = (
  input: MaterializationIdentity
): Effect.Effect<void, Failure> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const reserved = yield* foreign(() =>
      input.DB.prepare(`UPDATE statement_submissions
      SET source_parse_attempts=source_parse_attempts+1
      WHERE id=? AND user_id=? AND status IN ('queued','processing')
        AND source_parse_attempts<? AND parser_revision=? AND source_format=?
        AND retention_expires_at_ms=? AND retention_expires_at_ms>?
      RETURNING id`)
        .bind(
          input.submissionId,
          input.userId,
          maximumStatementSourceParses,
          input.parserRevision,
          input.sourceFormat,
          input.expiresAtMs,
          current
        )
        .all()
    );
    if (reserved.results.length === 0) {
      return yield* new StatementMaterializationFailed({ reason: "resource-limit" });
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
    const found = yield* findManifest(input);
    if (
      Option.isNone(found) ||
      !(yield* verifyPublication(input, found.value)) ||
      !(yield* publish(input, yield* Clock.currentTimeMillis))
    ) {
      return yield* failed();
    }
  }).pipe(Effect.mapError(normalize));
