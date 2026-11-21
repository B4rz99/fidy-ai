import { ConnectionInstitutions } from "../../../src/shell/connections/contract";
import { drainLocalIngestion } from "../../ingestion/runtime";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import {
  ErasureHandoff,
  LocalCustody,
  ResendScopePage,
  confirmDrainUrl,
  confirmPurgeUrl,
  connectionSuppressionStatus,
  erasedUserUrl,
  resendScopeCursor,
  resendScopeLimit,
  resendScopePageStatus,
} from "../../erasure-store/contract";
import { erasureRegistryName } from "../../erasure/contract";
import { userPrivateObjectPrefix } from "../../private-objects/operations";
import type { LocalIngestionEnvironment } from "../../ingestion/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";

const acknowledged = 204,
  missing = 404;

const conflict = 409;

const pageSize = 32;

const result = (ready: boolean): Response =>
  new Response(null, { status: ready ? acknowledged : conflict });

const decode = Effect.fn(function* (request: Request) {
  return yield* Effect.flatMap(
    Effect.tryPromise(() => request.json()),
    Schema.decodeUnknownEffect(ErasureHandoff, { onExcessProperty: "error" })
  );
});

export const keepErasedStoreEmpty = Effect.fn(function* (
  userName: Option.Option<string>,
  registry: DurableObjectNamespace
) {
  const sql = yield* SqliteClient;

  if ((yield* sql`SELECT 1 FROM sqlite_schema WHERE name='users'`).length > 0) return false;

  if (Option.isNone(userName)) return true;
  const name = userName.value;

  if (!Schema.is(ErasureHandoff.fields.userId)(name)) return false;

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureHandoff.fields.userId))(
    name
  );

  const response = yield* Effect.tryPromise((signal) =>
    registry.getByName(erasureRegistryName).fetch(erasedUserUrl, { method: "POST", body, signal })
  ).pipe(Effect.timeout("5 seconds"));

  if (response.status === missing) return false;

  if (response.status !== acknowledged) {
    return yield* Effect.fail("erasure_store_unavailable" as const);
  }

  return true;
});

const queryCase = Effect.fn(function* (
  scope: typeof ErasureHandoff.Type,
  registry: DurableObjectNamespace,
  url: string
) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureHandoff))(scope);

  const response = yield* Effect.tryPromise((signal) =>
    registry.getByName(erasureRegistryName).fetch(url, { method: "POST", body, signal })
  ).pipe(Effect.timeout("5 seconds"));

  return response;
});

type LocalErasureUnit = {
  env: LocalIngestionEnvironment & { ERASURE: DurableObjectNamespace };
  storage: DurableObjectStorage;
  owns: (id: string) => boolean;
};

export const drainLocalUser = Effect.fn(function* (
  request: Request,
  { env, storage, owns }: LocalErasureUnit
) {
  const scope = yield* decode(request);

  if (!owns(scope.userId)) return result(false);
  const sql = yield* SqliteClient;
  const exact = sql`id=${scope.reference} AND user_id=${scope.userId} AND requested_at_ms=${scope.requestedAtMs}`;

  if ((yield* sql`SELECT 1 FROM erasure_requests WHERE ${exact}`).length === 0) {
    return result(false);
  }

  const permit = yield* queryCase(scope, env.ERASURE, confirmDrainUrl);

  if (permit.status !== acknowledged) return result(false);

  const cursor = yield* Schema.decodeUnknownEffect(Schema.String)(
    permit.headers.get(resendScopeCursor)
  );

  const scopes =
    yield* sql`SELECT work_id,requested_at_ms FROM erasure_mail_scope WHERE work_id>${cursor} ORDER BY work_id LIMIT ${resendScopeLimit}`;

  if (scopes.length > 0) {
    const page = yield* Schema.decodeUnknownEffect(ResendScopePage)(scopes);

    return Response.json(page, { status: resendScopePageStatus });
  }

  yield* drainLocalIngestion(scope.userId, env);

  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      const routable =
        yield* sql`UPDATE connection_grants SET state='cleanup_required',cleanup_after_ms=${now} WHERE attempt_id IN(SELECT attempt_id FROM connection_grants WHERE state IN('active','quarantined') LIMIT ${pageSize}) RETURNING attempt_id`;

      if (routable.length > 0) yield* preserveStoreAlarm(storage, now);
      const institutions = yield* ConnectionInstitutions;
      const registered = sql.in("institution_id", institutions);

      const blocked =
        yield* sql`SELECT 1 WHERE EXISTS(SELECT 1 FROM connections WHERE ${registered}) OR EXISTS(SELECT 1 FROM connection_authorizations WHERE consent_id IS NOT NULL OR phase='preparing') OR EXISTS(SELECT 1 FROM connection_grants WHERE cleaned_at_ms IS NULL)`;

      if (blocked.length === 1) return new Response(null, { status: connectionSuppressionStatus });

      const ready =
        yield* sql`UPDATE erasure_requests SET state='Sealing',observed_custody=(SELECT json_object(
      'whatsapp', max(whatsapp,coalesce(json_extract(observed_custody,'$.whatsapp'),0)),
      'resend', max(resend,coalesce(json_extract(observed_custody,'$.resend'),0)),
      'wompi', max(wompi,coalesce(json_extract(observed_custody,'$.wompi'),0))) FROM local_erasure_custody) WHERE ${exact} AND state IN('Draining','Sealing') AND handoff_due_ms IS NULL AND NOT EXISTS(SELECT 1 FROM original_writers)
      AND NOT EXISTS(SELECT 1 FROM forwarded_email_receipts WHERE capacity_slot IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM media_capacity_receipts)
      AND NOT EXISTS(SELECT 1 FROM ingest_sample_reservations)
      AND NOT EXISTS(SELECT 1 FROM ingest_sample_decisions WHERE phase IN('approved','removing') OR (phase='published' AND sample_id>erasure_requests.sample_cursor))
      AND NOT EXISTS(SELECT 1 FROM whatsapp_deliveries WHERE started_ms IS NOT NULL AND state NOT IN('delivered','rejected'))
      AND NOT EXISTS(SELECT 1 FROM billing_attempts WHERE collection_state='sent' AND status='pending' AND no_charge_confirmed_at_ms IS NULL)
      AND NOT EXISTS(SELECT 1 FROM subscription_cancellations WHERE source_cancellation_state='void-pending' AND void_started_at_ms IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM payment_enrollments WHERE source_creation='issued' OR state IN('creating','verifying'))
      AND NOT EXISTS(SELECT 1 FROM login_email_proofs WHERE state='sending')
      AND NOT EXISTS(SELECT 1 FROM email_replacements WHERE state='sending')
      AND NOT EXISTS(SELECT 1 FROM hosted_turns WHERE state IN('queued','running','proposed'))
      RETURNING observed_custody`;

      if (ready.length !== 1) return result(false);

      const usage = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LocalCustody))(
        ready[0]?.observed_custody
      );

      return Response.json(usage);
    })
  );
});

const purgeObjectPage = Effect.fnUntraced(function* (
  bucket: Pick<R2Bucket, "list" | "delete">,
  prefix: string
) {
  const page = yield* Effect.tryPromise(() => bucket.list({ prefix, limit: pageSize }));

  if (page.objects.length === 0) return false;
  const keys = page.objects.map((object) => object.key);
  yield* Effect.tryPromise(() => bucket.delete(keys));

  return true;
});

export const purgeLocalUser = Effect.fn(function* (
  request: Request,
  { env, storage, owns }: LocalErasureUnit,
  retireSessions: Effect.Effect<void>
) {
  const scope = yield* decode(request);

  if (!owns(scope.userId)) return result(false);

  if ((yield* queryCase(scope, env.ERASURE, confirmPurgeUrl)).status !== acknowledged) {
    return result(false);
  }

  const sql = yield* SqliteClient;
  const populated = yield* sql`SELECT 1 FROM sqlite_schema WHERE name='erasure_requests'`;

  if (populated.length > 0) {
    const admitted =
      yield* sql`SELECT 1 FROM erasure_requests WHERE id=${scope.reference} AND user_id=${scope.userId} AND requested_at_ms=${scope.requestedAtMs} AND state='Sealing'`;

    if (admitted.length !== 1) return result(false);
  }

  const prefix = userPrivateObjectPrefix(scope.userId);

  const purged = yield* Effect.findFirst(
    [env.EMAIL_BUCKET, env.STATEMENT_STAGING_BUCKET],
    (bucket) => purgeObjectPage(bucket, prefix)
  );

  if (Option.isSome(purged)) return result(false);

  yield* retireSessions;
  yield* Effect.tryPromise(() => storage.deleteAlarm());
  yield* Effect.tryPromise(() => storage.deleteAll());

  return result((yield* Effect.tryPromise(() => storage.getAlarm())) === null);
});
