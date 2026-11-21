import { releaseDueMedia } from "./local-media";
import { captureWorkTrace } from "../../runtime/telemetry/operations";
import { settleBeforeDisposal } from "./original-writers";
import { recoverSamples } from "./sample-publication";
import { recoverDocumentStages, stageRetryMs } from "./local-document";
import { activateLocalEmail, emailStageRetryMs, recoverEmailStages } from "./local-email";
import { settleSharedEmailCapacity, updateSharedCapacity } from "./email-capacity";
import { newId } from "../../secret-material/operations";
import { UserId } from "../../../src/core/identity/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import { ConsentSubject } from "../../../src/shell/consent/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { erasePrivateObject } from "../../private-objects/operations";
import type { LocalIngestionEnvironment } from "../contract";

const pageSize = 32;

const voiceRetentionMs = 604_800_000;

const accountabilityLifetimeMs = 31_536_000_000;

const retryMs = 60_000;

const deferredRetryMs = 3_600_000;

const row = Schema.Struct({ id: Schema.String, user_id: Schema.String });

const countTrue = (outcomes: ReadonlyArray<boolean>): number => outcomes.filter(Boolean).length;

export const repairIngestionAlarm = Effect.fn(function* (
  current: number,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;

  const [next] = yield* sql`SELECT min(column1) AS due FROM (VALUES
      ((SELECT min(coalesce(work_last_attempt_at_ms+${retryMs},work_published_at_ms)) FROM statement_submissions WHERE work_published_at_ms IS NOT NULL)),
      ((SELECT min(d.last_stage_attempt_at_ms+${stageRetryMs}) FROM statement_documents d WHERE d.last_stage_attempt_at_ms<d.expires_at_ms AND NOT EXISTS(SELECT 1 FROM statement_submissions s WHERE s.id=d.id))),
      ((SELECT min(due_ms) FROM media_capacity_receipts)),
      ((SELECT min(accepted_at_ms)+${accountabilityLifetimeMs} FROM media_submissions)),
      ((SELECT min(claimed_ms)+${voiceRetentionMs} FROM whatsapp_voice_refusals)),
      ((SELECT min(expires_at_ms) FROM media_submissions WHERE capacity_held=1 OR media_id IS NOT NULL OR caption IS NOT NULL)),
      ((SELECT min(retention_expires_at_ms) FROM statement_submissions s WHERE EXISTS(SELECT 1 FROM statement_parts WHERE submission_id=s.id))),
      ((SELECT min(forget_at_ms) FROM statement_document_origins)),
      ((SELECT min(due_ms) FROM ingest_sample_decisions)),
      ((SELECT min(expires_at_ms) FROM ingest_sample_candidates)),
      ((SELECT min(expires_at_ms) FROM statement_documents WHERE object_key IS NOT NULL)),
      ((SELECT min(received_at_ms) FROM statement_documents WHERE disposition=1)),
      ((SELECT min(stage_checked_at_ms) FROM forwarded_email_receipts WHERE state='discarding')),
      ((SELECT min(coalesce(dispatch_sent_at_ms,received_at_ms)) FROM forwarded_email_receipts WHERE state='queued' AND outcome IS NOT NULL AND capacity_claimed=1 AND capacity_settled=0)),
      ((SELECT min(stage_checked_at_ms+${emailStageRetryMs}) FROM forwarded_email_receipts WHERE state='storing')),
      ((SELECT min(expires_at_ms) FROM forwarded_email_receipts WHERE state IN ('storing','queued'))),
      ((SELECT min(coalesce(deferred_checked_at_ms,dispatch_sent_at_ms,received_at_ms)+CASE WHEN deferred_checked_at_ms IS NULL THEN ${retryMs} ELSE ${deferredRetryMs} END) FROM forwarded_email_receipts WHERE state='queued' AND outcome IS NULL)),
      ((SELECT min(evidence_expires_at_ms) FROM ingestion_review_items WHERE evidence_state='retained' OR draft_json IS NOT NULL OR suggestions_json IS NOT NULL)))`;

  const due = yield* Schema.decodeUnknownEffect(Schema.NullOr(Schema.Int))(next?.due);

  return due === null ? false : yield* preserveStoreAlarm(storage, Math.max(current, due));
});

const expireReviewContent = Effect.fn(function* (current: number) {
  const sql = yield* SqliteClient;

  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sql`DELETE FROM ingest_sample_candidates WHERE id IN(SELECT id FROM ingest_sample_candidates WHERE expires_at_ms<=${current} ORDER BY expires_at_ms LIMIT ${pageSize})`;
      yield* sql`DELETE FROM whatsapp_voice_refusals WHERE rowid IN(SELECT rowid FROM whatsapp_voice_refusals WHERE claimed_ms<=${current - voiceRetentionMs} ORDER BY claimed_ms LIMIT ${pageSize})`;
      yield* sql`DELETE FROM ingestion_review_items WHERE source_kind='media' AND media_submission_id IN(SELECT id FROM media_submissions WHERE accepted_at_ms<=${current - accountabilityLifetimeMs} ORDER BY accepted_at_ms,id LIMIT ${pageSize})`;
      yield* sql`DELETE FROM media_submissions WHERE id IN(SELECT id FROM media_submissions WHERE accepted_at_ms<=${current - accountabilityLifetimeMs} ORDER BY accepted_at_ms,id LIMIT ${pageSize})`;
      yield* sql`UPDATE media_submissions SET caption=NULL,media_id=NULL,capacity_held=0 WHERE id IN(SELECT id FROM media_submissions WHERE expires_at_ms<=${current} AND (capacity_held=1 OR media_id IS NOT NULL OR caption IS NOT NULL) ORDER BY expires_at_ms LIMIT ${pageSize})`;
      yield* sql`UPDATE ingestion_review_items SET original_evidence=NULL,known_money_json=NULL,suggestions_json=NULL,draft_json=NULL,evidence_state=CASE WHEN evidence_state='retained' THEN 'expired' ELSE evidence_state END WHERE rowid IN(SELECT rowid FROM ingestion_review_items WHERE evidence_expires_at_ms<=${current} AND (evidence_state='retained' OR draft_json IS NOT NULL OR suggestions_json IS NOT NULL) ORDER BY evidence_expires_at_ms LIMIT ${pageSize})`;
    })
  );
});

const recoverStatements = Effect.fn(function* (
  current: number,
  storage: DurableObjectStorage,
  env: LocalIngestionEnvironment
) {
  const sql = yield* SqliteClient;

  const due = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sql`UPDATE statement_submissions SET status='failed',started_at_ms=coalesce(started_at_ms,${current}),completed_at_ms=${current},failure_reason='retention-expired',work_published_at_ms=NULL,work_last_attempt_at_ms=NULL WHERE id IN(SELECT id FROM statement_submissions WHERE retention_expires_at_ms<=${current} AND status IN ('queued','processing') ORDER BY retention_expires_at_ms LIMIT ${pageSize})`;
      yield* sql`DELETE FROM statement_document_origins WHERE rowid IN (SELECT rowid FROM statement_document_origins WHERE forget_at_ms<=${current} ORDER BY forget_at_ms LIMIT ${pageSize})`;
      yield* sql`DELETE FROM statement_parts WHERE rowid IN(SELECT p.rowid FROM statement_parts p JOIN statement_submissions s ON s.id=p.submission_id WHERE s.retention_expires_at_ms<=${current} ORDER BY s.retention_expires_at_ms,p.part LIMIT ${pageSize})`;
      yield* sql`DELETE FROM statement_backfill WHERE consumed_at_ms IS NULL AND submission_id IN(SELECT id FROM statement_documents WHERE expires_at_ms<=${current})`;

      return yield* sql`UPDATE statement_submissions SET work_last_attempt_at_ms=${current} WHERE id IN (SELECT id FROM statement_submissions WHERE work_published_at_ms IS NOT NULL AND (work_last_attempt_at_ms IS NULL OR work_last_attempt_at_ms<=${current - retryMs}) ORDER BY work_published_at_ms LIMIT ${pageSize}) RETURNING id,user_id`;
    })
  );

  const failures = yield* Effect.forEach(
    due,
    Effect.fnUntraced(function* (raw) {
      const item = yield* Schema.decodeUnknownEffect(row)(raw);

      const sent = yield* Effect.option(
        Effect.tryPromise(() =>
          env.STATEMENT_EXTRACTION_QUEUE.send({
            version: 1,
            userId: item.user_id,
            submissionId: item.id,
          })
        )
      );

      return Option.isNone(sent);
    })
  );

  const failed = countTrue(failures);

  yield* expireDocuments(current, env);
  const documents = yield* recoverDocumentStages(current, storage, env);

  return { attempted: due.length + documents.attempted, failed: failed + documents.failed };
});

const recoverEmailWork = Effect.fn(function* (current: number, env: LocalIngestionEnvironment) {
  const staged = yield* recoverEmailStages(current, env);
  const processed = yield* recoverEmails(current, env);

  return { ...processed, attempted: staged + processed.attempted };
});

export const recoverIngestion = Effect.fn(function* (
  current: number,
  storage: DurableObjectStorage,
  env: LocalIngestionEnvironment
) {
  const idle = { attempted: 0, failed: 0 };

  const tasks = [
    releaseDueMedia(env.DIRECTORY, current).pipe(Effect.as(idle)),
    expireReviewContent(current).pipe(Effect.as(idle)),
    recoverStatements(current, storage, env),
    recoverEmailWork(current, env),
    recoverSamples(current, env),
    repairIngestionAlarm(current, storage).pipe(Effect.as(idle)),
  ] as const;

  const results = yield* Effect.all(tasks, { mode: "result", concurrency: 1 });

  const outcomes = yield* Effect.forEach(results, Effect.fromResult);

  return {
    attempted: outcomes.reduce((sum, outcome) => sum + outcome.attempted, 0),
    failed: outcomes.reduce((sum, outcome) => sum + outcome.failed, 0),
  };
});

const expireDocuments = Effect.fn(function* (current: number, env: LocalIngestionEnvironment) {
  const sql = yield* SqliteClient;

  const expired =
    yield* sql`SELECT id,user_id,object_key FROM statement_documents WHERE disposition=1 OR expires_at_ms<=${current} ORDER BY expires_at_ms LIMIT ${pageSize}`;

  yield* Effect.forEach(
    expired,
    Effect.fnUntraced(function* (raw) {
      const item = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ ...row.fields, object_key: Schema.String })
      )(raw);

      yield* settleBeforeDisposal("statement", env.STATEMENT_STAGING_BUCKET, item);
      yield* erasePrivateObject({
        bucket: env.STATEMENT_STAGING_BUCKET,
        userId: item.user_id,
        key: item.object_key,
      });
      yield* withStoreCapacity("required")(
        Effect.gen(function* () {
          yield* sql`UPDATE statement_documents SET disposition=2,media_id='' WHERE user_id=${item.user_id} AND id=${item.id} AND disposition=1`;
          yield* sql`DELETE FROM statement_documents WHERE user_id=${item.user_id} AND id=${item.id} AND expires_at_ms<=${current}`;
          yield* sql`UPDATE statement_staging_objects SET object_deleted_at_ms=${current} WHERE id=${item.id} AND user_id=${item.user_id}`;
        })
      );
    }),
    { discard: true }
  );
});

const expireEmails = Effect.fn(function* (current: number, env: LocalIngestionEnvironment) {
  const sql = yield* SqliteClient;

  const expired =
    yield* sql`SELECT id,user_id,object_key,state FROM forwarded_email_receipts WHERE state='discarding' OR (state IN ('storing','queued') AND expires_at_ms<=${current}) ORDER BY expires_at_ms LIMIT ${pageSize}`;

  yield* Effect.forEach(
    expired,
    Effect.fnUntraced(function* (raw) {
      const target = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ ...row.fields, object_key: Schema.String, state: Schema.String })
      )(raw);

      yield* settleBeforeDisposal("email", env.EMAIL_BUCKET, target);
      yield* erasePrivateObject({
        userId: target.user_id,
        key: target.object_key,
        bucket: env.EMAIL_BUCKET,
      });
      yield* updateSharedCapacity(
        { directory: env.DIRECTORY, purpose: "email" },
        target.id,
        "Release"
      );
      yield* withStoreCapacity("required")(
        Effect.gen(function* () {
          if (target.state === "discarding") {
            yield* sql`DELETE FROM forwarded_email_receipts WHERE id=${target.id} AND user_id=${target.user_id} AND state='discarding'`;

            return;
          }

          yield* sql`INSERT INTO ingestion_review_items(id,user_id,source_kind,email_receipt_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone) SELECT ${newId()},user_id,'email',id,'processing-interrupted',${current},expires_at_ms,'CO','es-CO',time_zone FROM forwarded_email_receipts WHERE id=${target.id} AND user_id=${target.user_id} AND outcome IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=${target.user_id}) ON CONFLICT(email_receipt_id) DO NOTHING`;
          yield* sql`UPDATE forwarded_email_receipts SET outcome='needs-review',outcome_review_id=(SELECT id FROM ingestion_review_items WHERE email_receipt_id=${target.id}) WHERE id=${target.id} AND outcome IS NULL AND EXISTS(SELECT 1 FROM ingestion_review_items WHERE email_receipt_id=${target.id})`;
          yield* sql`UPDATE forwarded_email_receipts SET state='expired',object_key=NULL,deferred_checked_at_ms=NULL WHERE id=${target.id} AND user_id=${target.user_id} AND expires_at_ms<=${current}`;
          yield* sql`DELETE FROM ingest_sample_candidates WHERE receipt_id=${target.id} AND user_id=${target.user_id} AND expires_at_ms<=${current}`;
        })
      );
    }),
    { discard: true }
  );
});

const dispatchEmail = Effect.fn(function* (
  raw: unknown,
  current: number,
  env: LocalIngestionEnvironment
) {
  const sql = yield* SqliteClient;

  const target = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      ...row.fields,
      user_id: UserId,
      deferred_checked_at_ms: Schema.NullOr(Schema.Int),
    })
  )(raw);

  const claim = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const authority = protectConsentStatement({
        subject: ConsentSubject.User({ userId: target.user_id }),
        requirement: "granted",
        statement: {
          sql: "SELECT 1 FROM users WHERE id=? AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=?)",
          params: [target.user_id, target.user_id],
        },
      });

      if ((yield* sql.unsafe(authority.sql, authority.params)).length !== 1) {
        yield* sql`UPDATE forwarded_email_receipts SET outcome='consent-revoked' WHERE id=${target.id} AND outcome IS NULL`;

        return false;
      }

      if (target.deferred_checked_at_ms !== null) {
        yield* activateLocalEmail(target.user_id, target.id, current);
      }

      return (
        (yield* sql`UPDATE forwarded_email_receipts SET dispatch_sent_at_ms=${current} WHERE id=${target.id} AND outcome IS NULL AND deferred_checked_at_ms IS NULL AND expires_at_ms>${current} RETURNING id`)
          .length === 1
      );
    })
  );

  if (!claim) return Option.none<boolean>();
  const trace = yield* captureWorkTrace;

  const sent = yield* Effect.option(
    Effect.tryPromise(() =>
      env.FORWARDED_EMAIL_QUEUE.send({ receiptId: target.id, userId: target.user_id, ...trace })
    )
  );

  return Option.some(Option.isNone(sent));
});

const recoverEmails = Effect.fn(function* (current: number, env: LocalIngestionEnvironment) {
  const sql = yield* SqliteClient;
  yield* expireEmails(current, env);

  const completed =
    yield* sql`SELECT id FROM forwarded_email_receipts WHERE state='queued' AND outcome IS NOT NULL AND capacity_claimed=1 AND capacity_settled=0 ORDER BY received_at_ms LIMIT ${pageSize}`;

  yield* Effect.forEach(
    completed,
    (receipt) =>
      Schema.decodeUnknownEffect(Schema.String)(receipt.id).pipe(
        Effect.flatMap((id) => settleSharedEmailCapacity(env.DIRECTORY, id))
      ),
    { discard: true }
  );

  const candidates =
    yield* sql`SELECT id,user_id,deferred_checked_at_ms FROM forwarded_email_receipts WHERE state='queued' AND outcome IS NULL AND expires_at_ms>${current} AND (deferred_checked_at_ms IS NULL OR deferred_checked_at_ms<=${current - deferredRetryMs}) AND (dispatch_sent_at_ms IS NULL OR dispatch_sent_at_ms<=${current - retryMs}) ORDER BY coalesce(dispatch_sent_at_ms,received_at_ms),id LIMIT ${pageSize}`;

  const dispatches = yield* Effect.forEach(candidates, (raw) => dispatchEmail(raw, current, env));

  const attempts = dispatches.filter(Option.isSome).map((attempt) => attempt.value);

  return { attempted: attempts.length, failed: countTrue(attempts) };
});
