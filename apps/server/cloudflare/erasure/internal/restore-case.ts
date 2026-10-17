import { Clock, Effect, Option, Schema } from "effect";
import { type ErasureRecoveryConfiguration, ErasureRestoreAdmission } from "../contract";
import {
  ErasureOriginalLocator,
  type ErasureStore,
  ErasureUnavailable,
} from "../../erasure-store/contract";
import { RecoveryCase } from "./recovery-case";
import { expectedGeneration } from "./generation";

const maximumCaseBytes = 32768;
const maximumLocatorBytes = 2048;
const maximumObjects = 8;
const admissionLifetimeMs = 5000;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
const readMarker = (
  input: Readonly<{ bucket: R2Bucket; key: string; maximumBytes: number }>
): Effect.Effect<string, ErasureUnavailable> =>
  Effect.gen(function* () {
    const object = yield* io(() => input.bucket.get(input.key));
    if (object === null) return yield* new ErasureUnavailable();
    if (object.size > input.maximumBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    return yield* io(() => object.text());
  });
export const restoreCase = (
  input: Readonly<{
    configuration: ErasureRecoveryConfiguration;
    stores: ReadonlyArray<ErasureStore>;
    userId: string;
    candidate: unknown;
  }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const admission = yield* Schema.decodeUnknownEffect(ErasureRestoreAdmission, {
      onExcessProperty: "error",
    })(input.candidate);
    const current = yield* Clock.currentTimeMillis;
    if (
      admission.userId !== input.userId ||
      admission.deadlineMs <= current ||
      admission.deadlineMs > current + admissionLifetimeMs ||
      admission.authority.expiresAtMs <= current
    ) {
      return yield* new ErasureUnavailable();
    }
    if (Option.isNone(input.configuration.bucket)) return yield* new ErasureUnavailable();
    const generation = yield* expectedGeneration(input.configuration);
    if (generation.generation !== admission.generation) return yield* new ErasureUnavailable();
    const record = yield* reviewedCase({ configuration: input.configuration, admission });
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryCase.fields.decision))(
      record.decision
    );
    const inventory = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      input.stores.map(({ id, dataClass }) => ({ id, dataClass }))
    );
    yield* importCase({ ...input, admission, record, encoded, inventory });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const reviewedCase = (
  input: Readonly<{
    configuration: ErasureRecoveryConfiguration;
    admission: typeof ErasureRestoreAdmission.Type;
  }>
): Effect.Effect<typeof RecoveryCase.Type, ErasureUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { admission } = input;
    if (Option.isNone(input.configuration.bucket)) return yield* new ErasureUnavailable();
    const record = yield* Schema.decodeEffect(Schema.fromJsonString(RecoveryCase))(
      yield* readMarker({
        bucket: input.configuration.bucket.value,
        key: `recovery/cases/${admission.reference}`,
        maximumBytes: maximumCaseBytes,
      })
    );
    if (
      record.decision.userId !== admission.userId ||
      record.decision.reference !== admission.reference
    ) {
      return yield* new ErasureUnavailable();
    }
    return record;
  });

type CaseImport = Readonly<{
  configuration: ErasureRecoveryConfiguration;
  admission: typeof ErasureRestoreAdmission.Type;
  record: typeof RecoveryCase.Type;
  encoded: string;
  inventory: string;
}>;
const importCase = (input: CaseImport): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const {
      configuration: { db },
      admission,
      encoded,
      inventory,
    } = input;
    yield* io(() =>
      db.batch([
        restoredCaseStatement(input),
        db
          .prepare(`INSERT INTO erasure_steps(request_id,store_id,data_class,archive_done,delete_done)
      SELECT q.id,json_extract(s.value,'$.id'),json_extract(s.value,'$.dataClass'),0,0 FROM erasure_requests q,json_each(?) s
      WHERE q.id=? AND q.user_id=? AND q.state IN('Draining','Sealing') AND q.restore_generation=? AND q.decision_json=?
      ON CONFLICT(request_id,store_id) DO UPDATE SET archive_done=0,delete_done=0`)
          .bind(inventory, admission.reference, admission.userId, admission.generation, encoded),
        db
          .prepare(`INSERT INTO erasure_custody_evidence(request_id,custodian,state)
      SELECT q.id,p.value,'Pending' FROM erasure_requests q,json_each('["Cloudflare","Kapso","Meta","Resend","Wompi","SupportInbox","CaseRegister","CaseEvidence"]') p
      WHERE q.id=? AND q.user_id=? AND q.restore_generation=? ON CONFLICT(request_id,custodian) DO NOTHING`)
          .bind(admission.reference, admission.userId, admission.generation),
        db
          .prepare(
            "UPDATE erasure_custody_evidence SET state='Pending',evidence_json=NULL WHERE request_id=? AND custodian='Cloudflare' AND EXISTS(SELECT 1 FROM erasure_requests WHERE id=? AND user_id=? AND state='Sealing' AND restore_generation=?)"
          )
          .bind(admission.reference, admission.reference, admission.userId, admission.generation),
        db
          .prepare(`INSERT INTO erasure_restore_members(generation,request_id,user_id) SELECT restore_generation,id,user_id FROM erasure_requests
      WHERE id=? AND user_id=? AND restore_generation=? AND decision_json=? ON CONFLICT DO NOTHING`)
          .bind(admission.reference, admission.userId, admission.generation, encoded),
      ])
    );
    yield* ensureImported({ db, admission });
  });

const restoredCaseStatement = (input: CaseImport): D1PreparedStatement => {
  const { admission, record, encoded } = input;
  const db = input.configuration.db;
  return db
    .prepare(`INSERT INTO erasure_requests(id,user_id,case_ref,scope_ref,authority_ref,requested_at_ms,state,decision_json,reviewed_at_ms,operator_ref,restoring,restore_generation,archive_generation)
      VALUES(?,?,?,?,?,?,?, ?,?,?,1,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,decision_json=excluded.decision_json,case_ref=excluded.case_ref,
      scope_ref=excluded.scope_ref,authority_ref=excluded.authority_ref,reviewed_at_ms=excluded.reviewed_at_ms,operator_ref=excluded.operator_ref,
      restoring=1,restore_generation=excluded.restore_generation,archive_generation=excluded.archive_generation,
      restore_cursor='',restore_objects_done=0,restore_records_cursor='',restore_records_done=0,objects_captured=0,coordinator_cleared=0,marker_written=0,next_continuation_at_ms=0
      WHERE erasure_requests.user_id=excluded.user_id AND erasure_requests.restore_generation IS NOT excluded.restore_generation
      AND (erasure_requests.decision_json IS NULL OR json_remove(erasure_requests.decision_json,'$.receiptRetention','$.recovery.retention')=json_remove(excluded.decision_json,'$.receiptRetention','$.recovery.retention'))`)
    .bind(
      admission.reference,
      admission.userId,
      record.decision.caseRef,
      record.decision.scopeRef,
      record.decision.authorityRef,
      record.requestedAtMs,
      record.sealed ? "Sealing" : "Draining",
      encoded,
      record.reviewedAtMs,
      record.operatorRef,
      admission.generation,
      admission.generation
    );
};

const ensureImported = (
  input: Readonly<{ db: D1Database; admission: typeof ErasureRestoreAdmission.Type }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { db, admission } = input;
    const imported = yield* io(() =>
      db
        .prepare(
          "SELECT EXISTS(SELECT 1 FROM erasure_restore_members WHERE generation=? AND request_id=? AND user_id=?) AS imported"
        )
        .bind(admission.generation, admission.reference, admission.userId)
        .first<number>("imported")
    );
    if (imported !== 1) return yield* new ErasureUnavailable();
  });

export const importOriginalLocators = (
  input: Readonly<{
    configuration: ErasureRecoveryConfiguration;
    scope: Readonly<{ userId: string; reference: string }>;
  }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { db, bucket } = input.configuration;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const raw = yield* io(() =>
      db
        .prepare(
          "SELECT restoring,restore_cursor AS cursor,restore_objects_done AS done FROM erasure_requests WHERE id=? AND user_id=? AND state='Sealing'"
        )
        .bind(input.scope.reference, input.scope.userId)
        .first()
    );
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        restoring: Schema.Literals([0, 1]),
        cursor: Schema.String,
        done: Schema.Literals([0, 1]),
      })
    )(raw);
    if (row.restoring === 0 || row.done === 1) return true;
    const page = yield* io(() =>
      bucket.value.list({
        prefix: `recovery/objects/${input.scope.reference}/`,
        limit: maximumObjects,
        ...(row.cursor === "" ? {} : { cursor: row.cursor }),
      })
    );
    for (const object of page.objects) {
      yield* importLocator({ ...input, key: object.key });
    }
    yield* io(() =>
      db
        .prepare(
          "UPDATE erasure_requests SET restore_cursor=?,restore_objects_done=? WHERE id=? AND user_id=? AND state='Sealing'"
        )
        .bind(
          page.truncated ? page.cursor : "",
          page.truncated ? 0 : 1,
          input.scope.reference,
          input.scope.userId
        )
        .run()
    );
    return page.objects.length === 0 && !page.truncated;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const importLocator = (
  input: Readonly<{
    configuration: ErasureRecoveryConfiguration;
    scope: Readonly<{ userId: string; reference: string }>;
    key: string;
  }>
): Effect.Effect<void, ErasureUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { db, bucket } = input.configuration;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const locator = yield* Schema.decodeEffect(Schema.fromJsonString(ErasureOriginalLocator))(
      yield* readMarker({
        bucket: bucket.value,
        key: input.key,
        maximumBytes: maximumLocatorBytes,
      })
    );
    yield* io(() =>
      db
        .prepare(`INSERT INTO erasure_objects(request_id,bucket,object_key,recovery_written) VALUES(?,?,?,1)
      ON CONFLICT(request_id,bucket,object_key) DO UPDATE SET done=0,recovery_written=1`)
        .bind(input.scope.reference, locator.bucket, locator.key)
        .run()
    );
  });
