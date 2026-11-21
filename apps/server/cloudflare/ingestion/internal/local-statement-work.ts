import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Predicate, Result, Schema } from "effect";
import { UserContext, UserId } from "../../../src/core/identity/contract";
import {
  type InterpretedStatementRow,
  ParsedStatementRow,
  ReviewDraft,
  type StatementFailureReason,
  StatementRowEvidence,
} from "../../../src/core/ingestion/contract";
import {
  interpretStatementRows,
  mechanicalMappingFor,
  unmappedStatementRow,
} from "../../../src/core/ingestion/operations";
import { parseStatementFile } from "../../../src/shell/ingestion/operations";
import { TransactionExtraction } from "../../../src/core/transactions/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";
import { commitLocalWrite } from "../../canonical-admission/operations";
import { CanonicalAdmissionUnavailable } from "../../canonical-admission/contract";
import { prepareSourcedCapture } from "../../transactions/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { userPrivateObjectPrefix } from "../../private-objects/operations";
import { newId } from "../../secret-material/operations";
import { StatementCoordinatorActivity, StatementWork } from "../contract";
import {
  materializedHeaderBytes,
  materializedStatementBytes,
  statementReviewAdmission,
} from "./statement-review-budget";
import {
  maximumMaterializedHeaderBytes,
  maximumMaterializedStatementBytes,
  maximumStatementSourceParses,
  statementChunkSize,
} from "./statement-processing-limits";
import { maximumRetainedReviewEvidence } from "./statement-review-retention";

const isResponse = Schema.is(Schema.instanceOf(Response));

const createdStatus = 201;

const processedStatus = 200;

const notFoundStatus = 404;

const maximumPartBytes = 1_900_000;

const Stored = Schema.Struct({
  ...UserContext.fields,
  user: UserId,
  id: Schema.String,
  format: Schema.Literals(["csv", "xlsx"]),
  revision: Schema.String,
  expires: Schema.Int,
  key: Schema.String,
  sha: Schema.String,
  size: Schema.Int,
  headers: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.Int),
  processed: Schema.Int,
});

const find = Effect.fn(function* (work: typeof StatementWork.Type, current: number) {
  const sql = yield* SqliteClient;

  const guard = protectConsentStatement({
    subject: ConsentSubject.User({ userId: UserId.make(work.userId) }),
    requirement: "granted",
    statement: {
      sql: `SELECT s.id,s.user_id AS user,s.service_market AS serviceMarket,s.locale,s.time_zone AS timeZone,s.source_format AS format,
    s.parser_revision AS revision,s.retention_expires_at_ms AS expires,m.object_key AS key,m.sha256 AS sha,m.byte_length AS size,s.headers_json AS headers,s.materialized_rows AS total,s.processed_rows AS processed FROM statement_submissions s JOIN statement_staging_objects m ON m.id=s.staging_id AND m.user_id=s.user_id AND m.published_submission_id=s.id WHERE s.id=? AND s.user_id=? AND s.status IN ('queued','processing') AND s.retention_expires_at_ms>? AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=s.user_id)`,
      params: [work.submissionId, work.userId, current],
    },
  });

  const [raw] = yield* sql.unsafe(guard.sql, guard.params);

  return raw === undefined
    ? Option.none()
    : Option.some(yield* Schema.decodeUnknownEffect(Stored)(raw));
});

const finished = (): Response => new Response(null, { status: 200 });

const fail = Effect.fn(function* (
  row: typeof Stored.Type,
  now: number,
  reason: typeof StatementFailureReason.Type
) {
  const sql = yield* SqliteClient;
  yield* sql`UPDATE statement_submissions SET status='failed',failure_reason=${reason},started_at_ms=coalesce(started_at_ms,${now}),completed_at_ms=${now},work_published_at_ms=NULL,work_last_attempt_at_ms=NULL WHERE id=${row.id} AND user_id=${row.user} AND status IN ('queued','processing')`;
  yield* sql`DELETE FROM statement_parts WHERE submission_id=${row.id}`;
  yield* sql`DELETE FROM statement_backfill WHERE user_id=${row.user} AND submission_id=${row.id} AND consumed_at_ms IS NULL`;

  return finished();
});

const rowCodec = Schema.fromJsonString(Schema.toCodecJson(ParsedStatementRow));

const headerCodec = Schema.fromJsonString(Schema.Array(Schema.String));

const readStatementObject = Effect.fn(function* (row: typeof Stored.Type, bucket: R2Bucket) {
  if (
    !row.key.startsWith(userPrivateObjectPrefix(UserId.make(row.user)) + "staging/statement/v1/")
  ) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "statement_object" });
  }

  const object = yield* Effect.tryPromise(() => bucket.get(row.key));

  if (
    object === null ||
    object.size !== row.size ||
    object.customMetadata?.sha256 !== row.sha ||
    object.checksums.sha256 === undefined ||
    Uint8Array.from(new Uint8Array(object.checksums.sha256)).toHex() !== row.sha
  ) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "statement_object" });
  }

  return new Uint8Array(yield* Effect.tryPromise(() => object.arrayBuffer()));
});

const sameObject = (row: typeof Stored.Type, other: typeof Stored.Type): boolean =>
  row.key === other.key && row.sha === other.sha && row.expires === other.expires;

const materialize = Effect.fn(function* (
  work: typeof StatementWork.Type,
  row: typeof Stored.Type,
  bucket: R2Bucket
) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const reserved = yield* withStoreCapacity("required")(
    sql`UPDATE statement_submissions SET source_parse_attempts=source_parse_attempts+1,status='processing',started_at_ms=coalesce(started_at_ms,${now}) WHERE id=${row.id} AND user_id=${row.user} AND materialized_rows IS NULL AND source_parse_attempts<${maximumStatementSourceParses} AND status IN ('queued','processing') RETURNING id`
  );

  if (reserved.length === 0) {
    return yield* withStoreCapacity("required")(fail(row, now, "resource-limit"));
  }

  const bytes = yield* readStatementObject(row, bucket);
  const parsed = yield* Effect.result(parseStatementFile(bytes));

  return yield* withStoreCapacity("growth")(
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;

      const live = Option.filter(yield* find(work, current), (candidate) =>
        sameObject(row, candidate)
      );

      if (Option.isNone(live)) return finished();

      if (live.value.total !== null) return undefined;

      if (Result.isFailure(parsed)) return yield* fail(row, current, parsed.failure.safeReason);

      if (
        materializedStatementBytes(parsed.success.rows) > maximumMaterializedStatementBytes ||
        materializedHeaderBytes(parsed.success.headers) > maximumMaterializedHeaderBytes
      ) {
        return yield* fail(row, current, "resource-limit");
      }

      const values = yield* Effect.forEach(parsed.success.rows, (value) =>
        Schema.encodeEffect(rowCodec)(value)
      );

      if (values.some((value) => new TextEncoder().encode(value).byteLength > maximumPartBytes)) {
        return yield* fail(row, current, "resource-limit");
      }

      yield* Effect.forEach(
        values.entries(),
        Effect.fnUntraced(function* ([index, value]) {
          yield* sql`INSERT INTO statement_parts VALUES(${row.id},${index},${value})`;
        }),
        { discard: true }
      );

      yield* sql`UPDATE statement_submissions SET materialized_rows=${values.length},headers_json=${yield* Schema.encodeEffect(headerCodec)(parsed.success.headers)} WHERE id=${row.id}`;

      return undefined;
    })
  );
});

const extractorRevision = "statement-mechanical-v1";

type Outcome = InterpretedStatementRow<TransactionExtraction>;

const retainRejected = Effect.fn(function* (
  row: typeof Stored.Type,
  current: number,
  value: Outcome
) {
  const sql = yield* SqliteClient;

  const rejected =
    value.outcome === "needs-review"
      ? value
      : {
          ...value,
          reason: "canonical-validation-failed",
          suggestions: Option.none(),
          issues: [],
        };

  const [quota] =
    yield* sql`SELECT count(*) AS n FROM ingestion_review_items WHERE evidence_state='retained' AND evidence_expires_at_ms>${current}`;

  const retain = Number(quota?.n) < maximumRetainedReviewEvidence;
  yield* sql`INSERT INTO ingestion_review_items(id,user_id,source_kind,statement_submission_id,record_number,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,original_evidence,issues_json,evidence_state,suggestions_json)
        VALUES(${newId()},${row.user},'statement',${row.id},${value.recordNumber},${rejected.reason},${current},${row.expires},${row.serviceMarket},${row.locale},${row.timeZone},${row.format},${row.revision},${extractorRevision},${retain ? yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(StatementRowEvidence)))(value.evidence) : null},${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(rejected.issues)},${retain ? "retained" : "expired"},${Option.isSome(rejected.suggestions) ? yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(ReviewDraft)))(rejected.suggestions.value) : null})`;
});

const settleRow = Effect.fn(function* (row: typeof Stored.Type, current: number, value: Outcome) {
  if (
    value.outcome === "accepted" &&
    DateTime.toEpochMillis(value.extraction.occurredAt) <= current
  ) {
    const plan = yield* prepareSourcedCapture(
      { ...value.extraction, notes: Option.none(), categoryId: Option.none() },
      { userId: row.user, current },

      {
        kind: "statement-line",
        context: row,
        revision: row.revision,
        submissionId: row.id,
        recordNumber: value.recordNumber,
        sha256: row.sha,
        format: row.format,
      }
    );

    if ((yield* commitLocalWrite(plan)).status !== createdStatus) {
      return yield* new CanonicalAdmissionUnavailable({ cause: "statement_capture" });
    }

    return 1;
  }

  {
    yield* retainRejected(row, current, value);

    return 0;
  }
});

const finalize = Effect.fn(function* (work: typeof StatementWork.Type) {
  const current = yield* Clock.currentTimeMillis;
  const live = yield* find(work, current);

  if (Option.isNone(live)) return finished();
  const row = live.value;
  const sql = yield* SqliteClient;

  if (row.headers === null) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "statement_cursor" });
  }

  const mapping = mechanicalMappingFor(yield* Schema.decodeEffect(headerCodec)(row.headers));

  const raw =
    yield* sql`SELECT rows_json FROM statement_parts WHERE submission_id=${row.id} AND part>=${row.processed} ORDER BY part LIMIT ${statementChunkSize}`;

  const rows = yield* Effect.forEach(raw, (entry) =>
    Schema.decodeUnknownEffect(rowCodec)(entry.rows_json)
  );

  const results = Option.isSome(mapping)
    ? (yield* interpretStatementRows(
        { rows, mapping: mapping.value, timeZone: row.timeZone },
        Schema.decodeUnknownEffect(Schema.toCodecJson(TransactionExtraction))
      )).outcomes
    : rows.map(unmappedStatementRow);

  const admit = statementReviewAdmission({
    userId: row.user,
    submissionId: row.id,
    serviceMarket: row.serviceMarket,
    locale: row.locale,
    timeZone: row.timeZone,
    sourceFormat: row.format,
    parserRevision: row.revision,
    extractorRevision,
    expiresAt: row.expires,
    createdAt: current,
  });

  if (results.some((value) => value.outcome === "needs-review" && !admit(value))) {
    return yield* fail(row, current, "resource-limit");
  }

  let accepted = 0;

  yield* Effect.forEach(
    results,
    Effect.fnUntraced(function* (value) {
      accepted += yield* settleRow(row, current, value);
    }),
    { discard: true }
  );

  if (accepted > 0) {
    yield* sql`UPDATE statement_backfill SET consumed_at_ms=coalesce(consumed_at_ms,${current}) WHERE user_id=${row.user} AND submission_id=${row.id}`;
  }

  const complete = row.processed + rows.length === row.total;
  yield* sql`UPDATE statement_submissions SET processed_rows=processed_rows+${rows.length},processed_accepted_rows=processed_accepted_rows+${accepted},processed_review_rows=processed_review_rows+${rows.length - accepted} WHERE id=${row.id}`;

  if (!complete) return new Response(null, { status: 202 });
  yield* sql`UPDATE statement_submissions SET status='completed',completed_at_ms=${current},work_published_at_ms=NULL,work_last_attempt_at_ms=NULL,clarification_state=CASE WHEN processed_review_rows>0 THEN 'awaiting' ELSE 'completed' END,clarification_expires_at_ms=retention_expires_at_ms WHERE id=${row.id}`;
  yield* sql`DELETE FROM statement_parts WHERE submission_id=${row.id}`;

  return finished();
});

export const localStatementActivity = Effect.fn(function* (
  request: Request,
  bucket: R2Bucket,
  owns: (user: string) => boolean
) {
  const work = yield* Schema.decodeUnknownEffect(StatementCoordinatorActivity)(
    yield* Effect.tryPromise(() => request.json())
  );

  if (!owns(work.userId)) return new Response(null, { status: 404 });
  const now = yield* Clock.currentTimeMillis;
  const row = yield* find(work, now);

  if (Option.isNone(row)) return finished();

  if (Predicate.isTagged(work, "StatementFailed")) {
    return yield* withStoreCapacity("required")(fail(row.value, now, "mapping-unavailable"));
  }

  if (row.value.total === null) {
    const stop = yield* materialize(work, row.value, bucket);

    if (isResponse(stop)) return stop;
  }

  return yield* withStoreCapacity("growth")(finalize(work));
});

export const localPendingStatement = Effect.fn(function* (
  request: Request,
  owns: (id: string) => boolean
) {
  const work = yield* Schema.decodeUnknownEffect(StatementWork)(
    yield* Effect.tryPromise(() => request.json())
  );

  if (!owns(work.userId)) return new Response(null, { status: 404 });
  const found = yield* find(work, yield* Clock.currentTimeMillis);

  return new Response(null, { status: Option.isSome(found) ? processedStatus : notFoundStatus });
});
