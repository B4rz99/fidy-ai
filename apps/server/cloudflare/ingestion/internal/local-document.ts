import { CanonicalAdmissionUnavailable } from "../../canonical-admission/contract";
import type { LocalIngestionRequest } from "../contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";
import { activeProUserCondition } from "../../../src/shell/access-tier/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";
import { UserId } from "../../../src/core/identity/contract";
import {
  knownUnsupportedStatementBytes,
  statementSourceFormat,
} from "../../../src/shell/ingestion/operations";
import {
  maximumOutstandingStatementSubmissions,
  maximumStatementSubmissionsPerHour,
  statementParserRevision,
  statementStagingLifetimeMilliseconds,
} from "../../../src/core/ingestion/contract";
import { makeKapsoOutboundHttp } from "../../../src/shell/outbound-http/operations";
import { settleObservedOriginal, trackOriginalPut } from "./original-writers";
import { resumePrivateUpload, userPrivateObjectPrefix } from "../../private-objects/operations";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";

import { type LocalIngestionEnvironment, NativeStatementDocument } from "../contract";
import { retrieveHeldStatementMedia } from "./statement-document";

const timestampResolutionMs = 1000;

const serverErrorStatus = 500,
  forbidden = 403,
  conflict = 409,
  unprocessable = 422;

export const stageRetryMs = 60000;

const hourMs = 3_600_000;

const rowSchema = Schema.Struct({
  id: Schema.String,
  media_id: Schema.String,
  endpoint: Schema.String,
  occurred_at_ms: Schema.Int,
  expires_at_ms: Schema.Int,
  object_key: Schema.String,
  unsupported: Schema.Int,
  disposition: Schema.Int,
});

type Document = typeof NativeStatementDocument.Type;

type Origin = (
  doc: Document,
  storage: DurableObjectStorage
) => Effect.Effect<Option.Option<Response>, CanonicalAdmissionUnavailable, SqliteClient>;

const live = Effect.fn(function* (doc: Document, current: number) {
  const sql = yield* SqliteClient;

  const query = protectConsentStatement({
    subject: ConsentSubject.User({ userId: UserId.make(doc.userId) }),
    requirement: "active",
    statement: {
      sql: "SELECT 1 FROM users WHERE id=? AND whatsapp_portfolio_id=? AND whatsapp_bsuid=? AND whatsapp_verified_at_ms<=? AND NOT EXISTS (SELECT 1 FROM erasure_requests WHERE user_id=?) AND NOT EXISTS(SELECT 1 FROM statement_document_origins WHERE user_id=users.id AND message=? AND (expires_at_ms<=? OR occurred_at_ms!=?))",
      params: [
        doc.userId,
        doc.portfolio,
        doc.bsuid,
        doc.occurredAt + timestampResolutionMs - 1,
        doc.userId,
        doc.message,
        current,
        doc.occurredAt,
      ],
    },
  });

  return (
    (yield* sql.unsafe(query.sql, query.params)).length === 1 &&
    current < doc.occurredAt + statementStagingLifetimeMilliseconds
  );
});

const resumeDocument = Effect.fn(function* (
  row: typeof rowSchema.Type,
  doc: Document,
  current: number
) {
  const sql = yield* SqliteClient;

  if (row.disposition !== 0) return new Response(null, { status: forbidden });

  if (
    row.media_id !== doc.mediaId ||
    row.endpoint !== doc.endpoint ||
    row.occurred_at_ms !== doc.occurredAt ||
    row.expires_at_ms <= current
  ) {
    return new Response(null, { status: 409 });
  }

  if (row.unsupported === 1) return new Response(null, { status: unprocessable });

  const [submission] =
    yield* sql`SELECT id FROM statement_submissions WHERE id=${row.id} AND user_id=${doc.userId}`;

  return submission === undefined ? row : new Response(null, { status: 202 });
});

const availableCapacity = Effect.fn(function* (doc: Document, current: number) {
  const sql = yield* SqliteClient;
  const pro = activeProUserCondition({ userId: doc.userId, nowEpochMs: current });

  const [admission] = yield* sql.unsafe(
    `SELECT ${pro.sql} AS pro,EXISTS(SELECT 1 FROM statement_backfill WHERE user_id=?) AS reserved,
    (SELECT COUNT(*) FROM statement_documents WHERE user_id=? AND received_at_ms>?) AS recent,
    (SELECT count(*) FROM statement_documents d LEFT JOIN statement_submissions s ON s.id=d.id WHERE d.user_id=? AND d.expires_at_ms>? AND d.unsupported=0 AND d.disposition=0 AND (s.id IS NULL OR s.status IN ('queued','processing'))) AS pending`,
    [...pro.params, doc.userId, doc.userId, current - hourMs, doc.userId, current]
  );

  const budget = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      pro: Schema.Int,
      reserved: Schema.Int,
      recent: Schema.Int,
      pending: Schema.Int,
    })
  )(admission);

  if (budget.pro === 0 && budget.reserved === 1) {
    return { refused: new Response(null, { status: 402 }) };
  }

  if (
    budget.recent >= maximumStatementSubmissionsPerHour ||
    budget.pending >= maximumOutstandingStatementSubmissions
  ) {
    return { refused: new Response(null, { status: 429 }) };
  }

  return budget;
});

const reserve = Effect.fn(function* (
  doc: Document,
  current: number,
  { storage, origin }: { storage: DurableObjectStorage; origin: Option.Option<Origin> }
) {
  const sql = yield* SqliteClient;

  if (!(yield* live(doc, current))) return new Response(null, { status: 403 });

  const [prior] =
    yield* sql`SELECT * FROM statement_documents WHERE user_id=${doc.userId} AND portfolio=${doc.portfolio} AND message=${doc.message}`;

  if (prior !== undefined) {
    return yield* resumeDocument(yield* Schema.decodeUnknownEffect(rowSchema)(prior), doc, current);
  }

  const budget = yield* availableCapacity(doc, current);

  if ("refused" in budget) return budget.refused;

  if (Option.isNone(origin)) return new Response(null, { status: conflict });
  const refused = yield* origin.value(doc, storage);

  if (Option.isSome(refused)) return refused.value;

  const id = newId(),
    expires = doc.occurredAt + statementStagingLifetimeMilliseconds,
    key = userPrivateObjectPrefix(UserId.make(doc.userId)) + "staging/statement/v1/" + newId();

  yield* sql`INSERT INTO statement_documents VALUES(${id},${doc.userId},${doc.portfolio},${doc.bsuid},${doc.message},${doc.endpoint},${doc.mediaId},${doc.occurredAt},${doc.receivedAt},${expires},${key},${current},0,0)`;

  if (budget.pro === 0) yield* sql`INSERT INTO statement_backfill VALUES(${doc.userId},${id},NULL)`;
  yield* preserveStoreAlarm(storage, Math.min(expires, current + stageRetryMs));

  return {
    id,
    object_key: key,
    unsupported: 0,
    disposition: 0,
    expires_at_ms: expires,
    media_id: doc.mediaId,
    endpoint: doc.endpoint,
    occurred_at_ms: doc.occurredAt,
  };
});

const storedMaterial = Schema.Struct({
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  format: Schema.Literals(["csv", "xlsx"]),
  purpose: Schema.Literal("statement"),
});

const stageDocument = Effect.fn(function* (
  row: typeof rowSchema.Type,
  doc: Document,
  { env, current }: { env: LocalIngestionEnvironment; current: number }
) {
  const bucket = env.STATEMENT_STAGING_BUCKET;

  if (
    !row.object_key.startsWith(
      userPrivateObjectPrefix(UserId.make(doc.userId)) + "staging/statement/v1/"
    )
  ) {
    return new Response(null, { status: 409 });
  }

  const head = yield* Effect.tryPromise(() => bucket.head(row.object_key));
  yield* settleObservedOriginal("statement", row.object_key, Option.fromNullOr(head));
  const stored = Schema.decodeUnknownOption(storedMaterial)(head?.customMetadata);

  if (
    head !== null &&
    Option.isSome(stored) &&
    head.checksums.sha256 !== undefined &&
    new Uint8Array(head.checksums.sha256).toHex() === stored.value.sha256
  ) {
    return {
      sha256: stored.value.sha256,
      sourceFormat: stored.value.format,
      byteLength: head.size,
    };
  }

  const httpClient = yield* HttpClient.HttpClient;

  const media = yield* retrieveHeldStatementMedia({
    outbound: makeKapsoOutboundHttp({ httpClient, apiKey: Redacted.make(env.KAPSO_API_KEY) }),
    mediaId: doc.mediaId,
    businessPhoneNumberId: doc.endpoint,
    current,
  });

  if (knownUnsupportedStatementBytes(media.bytes)) return new Response(null, { status: 422 });
  const sha = media.sha256;
  const format = statementSourceFormat(media.bytes);
  yield* resumePrivateUpload(
    {
      bucket,
      userId: doc.userId,
      put: (key, bytes, options) =>
        trackOriginalPut({ bucket, kind: "statement", user: doc.userId }, { key, bytes, options }),
      key: row.object_key,
      bytes: media.bytes,
      metadata: {
        purpose: "statement",
        format,
        sha256: sha,
        expiresAtMs: String(row.expires_at_ms),
      },
      digest: Option.some(Uint8Array.fromHex(sha)),
      predecessor: Option.none(),
      authorise: Effect.flatMap(Clock.currentTimeMillis, (now) => live(doc, now)),
    },
    Option.fromNullOr(head)
  );

  return { sha256: sha, sourceFormat: format, byteLength: media.bytes.length };
});

const refuseUnsupported = Effect.fn(function* (id: string, user: string) {
  const sql = yield* SqliteClient;
  yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sql`UPDATE statement_documents SET unsupported=1,last_stage_attempt_at_ms=expires_at_ms WHERE id=${id} AND user_id=${user}`;
      yield* sql`DELETE FROM statement_backfill WHERE user_id=${user} AND submission_id=${id} AND consumed_at_ms IS NULL`;
    })
  );

  return new Response(null, { status: unprocessable });
});

const discardUnpublished = Effect.fn(function* (
  id: string,
  storage: DurableObjectStorage,
  now: number
) {
  const sql = yield* SqliteClient;

  const discarded =
    yield* sql`UPDATE statement_documents SET disposition=1,last_stage_attempt_at_ms=expires_at_ms WHERE id=${id} AND disposition=0 AND NOT EXISTS(SELECT 1 FROM statement_submissions WHERE id=${id}) RETURNING id`;

  if (discarded.length === 0) return;
  yield* sql`DELETE FROM statement_backfill WHERE submission_id=${id} AND consumed_at_ms IS NULL`;
  yield* preserveStoreAlarm(storage, now);
});

const publishDocument = Effect.fn(function* (
  doc: Document,
  storage: DurableObjectStorage,
  { env, origin }: { env: LocalIngestionEnvironment; origin: Option.Option<Origin> }
) {
  const current = yield* Clock.currentTimeMillis;
  const row = yield* withStoreCapacity("growth")(reserve(doc, current, { storage, origin }));

  if (row instanceof Response) return row;
  const material = yield* stageDocument(row, doc, { env, current });

  if (material instanceof Response) {
    return material.status === unprocessable
      ? yield* refuseUnsupported(row.id, doc.userId)
      : material;
  }

  const { sha256, sourceFormat, byteLength } = material;
  const sql = yield* SqliteClient;

  return yield* withStoreCapacity("growth")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      const exact =
        yield* sql`SELECT id FROM statement_documents WHERE id=${row.id} AND user_id=${doc.userId} AND disposition=0 AND expires_at_ms>${now}`;

      if (exact.length === 0 || !(yield* live(doc, now))) {
        yield* discardUnpublished(row.id, storage, now);

        return new Response(null, { status: 403 });
      }

      yield* sql`INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms,published_submission_id,source_format)
      VALUES(${row.id},${doc.userId},${row.object_key},${byteLength},${sha256},'published',${doc.occurredAt},${row.expires_at_ms},${row.id},${sourceFormat}) ON CONFLICT(id) DO NOTHING`;
      yield* sql`INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,retention_expires_at_ms,work_published_at_ms,hosted_session_id,hosted_turn_id,hosted_expires_at_ms)
      SELECT ${row.id},id,${row.id},${row.id},${now},${sourceFormat},${statementParserRevision},service_market,locale,time_zone,${row.expires_at_ms},${now},origin.session_id,origin.turn_id,min(origin.expires_at_ms,${row.expires_at_ms}) FROM users LEFT JOIN statement_document_origins origin ON origin.user_id=users.id AND origin.message=${doc.message} WHERE users.id=${doc.userId} ON CONFLICT(id) DO NOTHING`;
      yield* preserveStoreAlarm(storage, now);

      return new Response(null, { status: 202 });
    })
  );
});

export const admitLocalDocument = Effect.fn(
  function* ({ request, env, owns, storage }: LocalIngestionRequest, origin: Origin) {
    const doc = yield* Schema.decodeUnknownEffect(NativeStatementDocument)(
      yield* Effect.tryPromise(() => request.json())
    );

    if (!owns(doc.userId)) return new Response(null, { status: 404 });

    return yield* publishDocument(doc, storage, { env, origin: Option.some(origin) });
  },
  Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
);

export const retainDocumentOrigin = Effect.fn(function* (input: {
  user: UserId;
  message: string;
  sessionId: string;
  turnId: string;
  occurredAt: number;
  expiresAt: number;
}) {
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;

  if (
    input.expiresAt <= current ||
    input.occurredAt + statementStagingLifetimeMilliseconds <= current
  ) {
    return false;
  }

  const [stored] =
    yield* sql`INSERT INTO statement_document_origins(user_id,message,session_id,turn_id,occurred_at_ms,expires_at_ms,forget_at_ms)
  SELECT ${input.user},${input.message},${input.sessionId},${input.turnId},${input.occurredAt},${input.expiresAt},${input.occurredAt + statementStagingLifetimeMilliseconds}
  WHERE NOT EXISTS(SELECT 1 FROM statement_documents WHERE user_id=${input.user} AND message=${input.message})
  AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=${input.user})
  ON CONFLICT(user_id,message) DO NOTHING RETURNING message`;

  if (stored !== undefined) return true;

  const existing =
    yield* sql`SELECT 1 FROM statement_document_origins WHERE user_id=${input.user} AND message=${input.message} AND session_id=${input.sessionId} AND turn_id=${input.turnId} AND occurred_at_ms=${input.occurredAt} AND expires_at_ms=${input.expiresAt}`;

  return existing.length === 1;
});

export const recoverDocumentStages = Effect.fn(function* (
  current: number,
  storage: DurableObjectStorage,
  env: LocalIngestionEnvironment
) {
  const sql = yield* SqliteClient;

  const rows = yield* withStoreCapacity("required")(
    sql`UPDATE statement_documents SET last_stage_attempt_at_ms=${current} WHERE id IN(SELECT d.id FROM statement_documents d WHERE d.last_stage_attempt_at_ms<=${current - stageRetryMs} AND d.expires_at_ms>${current} AND NOT EXISTS(SELECT 1 FROM statement_submissions s WHERE s.id=d.id) ORDER BY d.last_stage_attempt_at_ms LIMIT 8) RETURNING id,user_id AS userId,portfolio,bsuid,message,endpoint,media_id AS mediaId,occurred_at_ms AS occurredAt,received_at_ms AS receivedAt`
  );

  let failed = 0;

  yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (raw) {
      const doc = yield* Schema.decodeUnknownEffect(NativeStatementDocument)(raw);

      const publication = yield* Effect.option(
        publishDocument(doc, storage, { env, origin: Option.none() })
      );

      if (Option.isNone(publication) || publication.value.status >= serverErrorStatus) failed++;

      if (Option.isSome(publication) && publication.value.status === forbidden) {
        const id = yield* Schema.decodeUnknownEffect(Schema.String)(raw.id);
        yield* withStoreCapacity("required")(discardUnpublished(id, storage, current));
      } else if (
        Option.isSome(publication) &&
        [conflict, unprocessable].includes(publication.value.status)
      ) {
        yield* withStoreCapacity("required")(
          sql`UPDATE statement_documents SET last_stage_attempt_at_ms=expires_at_ms WHERE user_id=${doc.userId} AND portfolio=${doc.portfolio} AND message=${doc.message}`
        );
      }
    }),
    { discard: true }
  );

  return { attempted: rows.length, failed };
});
