import { Clock, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { ErasureClass, ErasureDecision } from "../../../src/core/erasure/contract";
import { UserId } from "../../../src/core/identity/contract";
import { type ErasureScope, ErasureUnavailable } from "../../erasure-store/contract";
import { digestBytes } from "../../secret-material/operations";
import { erasePrivateObject, writePrivateObject } from "../../private-objects/operations";
import type { ErasureRecoveryConfiguration } from "../contract";

const maximumRecords = 4;
const maximumRecordBytes = 8388608;
const maximumBodyLength = 1048576;
const RecordCopy = Schema.Struct({
  userId: UserId,
  storeId: Schema.String,
  rowRef: Schema.String,
  dataClass: ErasureClass,
  untilMs: Schema.Int,
  body: Schema.String.check(Schema.isMaxLength(maximumBodyLength)),
});
const Pending = Schema.Struct({
  storeId: Schema.String,
  rowRef: Schema.String,
  dataClass: ErasureClass,
  body: Schema.String,
});
type ArchiveInput = Readonly<{ configuration: ErasureRecoveryConfiguration; scope: ErasureScope }>;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
const copyRecord = (
  input: ArchiveInput & Readonly<{ record: typeof Pending.Type; untilMs: number }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bucket = input.configuration.bucket;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const name = Hex.encode(
      yield* digestBytes(new TextEncoder().encode(`${input.record.storeId}:${input.record.rowRef}`))
    );
    const key = `held-records/${input.scope.reference}/${input.record.dataClass}/${name}`;
    const copy = yield* Schema.decodeEffect(RecordCopy)({
      ...input.record,
      userId: UserId.make(input.scope.userId),
      untilMs: input.untilMs,
    });
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RecordCopy))(copy);
    yield* persistCopy({ ...input, key, encoded });
    yield* io(() =>
      input.configuration.db
        .prepare(
          "UPDATE erasure_archives SET recovery_written=1 WHERE request_id=? AND store_id=? AND row_ref=? AND body=?"
        )
        .bind(input.scope.reference, input.record.storeId, input.record.rowRef, input.record.body)
        .run()
    );
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const persistCopy = (
  input: ArchiveInput &
    Readonly<{ record: typeof Pending.Type; untilMs: number; key: string; encoded: string }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { key, encoded } = input;
    const bucket = input.configuration.bucket;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const previous = Option.fromNullOr(yield* io(() => bucket.value.get(key)));
    if (
      Option.isSome(previous) &&
      previous.value.customMetadata?.purpose === "titular-held-record"
    ) {
      yield* verifyCopy({ object: previous.value, encoded });
    } else {
      const predecessor = yield* writablePredecessor(previous);
      yield* writePrivateObject({
        bucket: bucket.value,
        key,
        bytes: new TextEncoder().encode(encoded),
        digest: Option.none(),
        predecessor,
        metadata: {
          purpose: "titular-held-record",
          expiresAtMs: String(input.untilMs),
          dataClass: input.record.dataClass,
        },
        authorise: mayCopyRecord(input),
      });
    }
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const mayCopyRecord = (
  input: ArchiveInput & Readonly<{ record: typeof Pending.Type }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((current) =>
      io(() =>
        input.configuration.db
          .prepare(`SELECT count(*) AS approved FROM erasure_requests
        WHERE id=? AND user_id=? AND state='Archiving' AND json_extract(decision_json,?)>?`)
          .bind(
            input.scope.reference,
            input.scope.userId,
            `$.dispositions.${input.record.dataClass}.retention.untilMs`,
            current
          )
          .first<number>("approved")
      )
    ),
    Effect.map((approved) => approved === 1)
  );

export const checkpointHeldRecords = (
  input: ArchiveInput
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* io(() =>
      input.configuration.db
        .prepare(
          `SELECT decision_json AS decision FROM erasure_requests WHERE id=? AND user_id=? AND state='Archiving'`
        )
        .bind(input.scope.reference, input.scope.userId)
        .first()
    );
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ decision: Schema.fromJsonString(ErasureDecision) })
    )(raw);
    const records = yield* io(() =>
      input.configuration.db
        .prepare(`SELECT a.store_id AS storeId,a.row_ref AS rowRef,s.data_class AS dataClass,a.body
    FROM erasure_archives a JOIN erasure_steps s ON s.request_id=a.request_id AND s.store_id=a.store_id
    WHERE a.request_id=? AND a.recovery_written=0 LIMIT ?`)
        .bind(input.scope.reference, maximumRecords)
        .all()
    );
    const pending = yield* Schema.decodeUnknownEffect(Schema.Array(Pending))(records.results);
    if (pending.length === 0) return true;
    for (const record of pending) {
      const disposition = row.decision.dispositions[record.dataClass];
      if (disposition.action !== "Retain") return yield* new ErasureUnavailable();
      if (disposition.retention.untilMs <= (yield* Clock.currentTimeMillis)) {
        yield* io(() =>
          input.configuration.db
            .prepare("DELETE FROM erasure_archives WHERE request_id=? AND store_id=? AND row_ref=?")
            .bind(input.scope.reference, record.storeId, record.rowRef)
            .run()
        );
      } else yield* copyRecord({ ...input, record, untilMs: disposition.retention.untilMs });
    }
    return false;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

export const purgeHeldRecords = (input: ArchiveInput): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bucket = input.configuration.bucket;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const cursor = yield* io(() =>
      input.configuration.db
        .prepare(
          "SELECT purge_records_cursor AS cursor FROM erasure_requests WHERE id=? AND user_id=? AND state='ExternalPending'"
        )
        .bind(input.scope.reference, input.scope.userId)
        .first<string>("cursor")
    );
    if (cursor === null) return yield* new ErasureUnavailable();
    const page = yield* io(() =>
      bucket.value.list({
        prefix: `held-records/${input.scope.reference}/`,
        limit: maximumRecords,
        include: ["customMetadata"],
        ...(cursor === "" ? {} : { cursor }),
      })
    );
    yield* io(() =>
      input.configuration.db
        .prepare("UPDATE erasure_requests SET purge_records_cursor=? WHERE id=? AND user_id=?")
        .bind(page.truncated ? page.cursor : "", input.scope.reference, input.scope.userId)
        .run()
    );
    if (page.objects.length === 0) return cursor === "";
    const current = yield* Clock.currentTimeMillis;
    for (const object of page.objects) {
      yield* purgeRecord({ ...input, bucket: bucket.value, object, current });
    }
    return false;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const purgeRecord = (
  input: ArchiveInput & Readonly<{ bucket: R2Bucket; object: R2Object; current: number }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { object, current } = input;
    if (!(yield* expiredCopy({ object, current }))) return;
    yield* markPurgePending(input);
    yield* erasePrivateObject({ bucket: input.bucket, key: object.key });
    if ((yield* io(() => input.bucket.head(object.key))) !== null) {
      return yield* new ErasureUnavailable();
    }
    yield* io(() =>
      input.configuration.db.batch([
        input.configuration.db
          .prepare("UPDATE erasure_requests SET last_erased_at_ms=? WHERE id=? AND user_id=?")
          .bind(current, input.scope.reference, input.scope.userId),
        input.configuration.db
          .prepare(
            "UPDATE erasure_custody_records SET state='Pending',current_event_id=NULL WHERE record_type='current' AND request_id=? AND custodian='Cloudflare'"
          )
          .bind(input.scope.reference),
      ])
    );
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

export const importHeldRecords = (
  input: ArchiveInput
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { db, bucket } = input.configuration;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const raw = yield* io(() =>
      db
        .prepare(
          "SELECT restoring,restore_records_cursor AS cursor,restore_records_done AS done,decision_json AS decision FROM erasure_requests WHERE id=? AND user_id=? AND state='Sealing'"
        )
        .bind(input.scope.reference, input.scope.userId)
        .first()
    );
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        restoring: Schema.Literals([0, 1]),
        cursor: Schema.String,
        done: Schema.Literals([0, 1]),
        decision: Schema.fromJsonString(ErasureDecision),
      })
    )(raw);
    if (row.restoring === 0 || row.done === 1) return true;
    const page = yield* io(() =>
      bucket.value.list({
        prefix: `held-records/${input.scope.reference}/`,
        limit: maximumRecords,
        ...(row.cursor === "" ? {} : { cursor: row.cursor }),
      })
    );
    for (const object of page.objects) {
      yield* importRecord({ ...input, key: object.key, decision: row.decision });
    }
    yield* io(() =>
      db
        .prepare(
          "UPDATE erasure_requests SET restore_records_cursor=?,restore_records_done=? WHERE id=? AND user_id=? AND state='Sealing'"
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
const importRecord = (
  input: ArchiveInput & Readonly<{ key: string; decision: ErasureDecision }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bucket = input.configuration.bucket;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const object = yield* io(() => bucket.value.get(input.key));
    if (object === null) return yield* new ErasureUnavailable();
    if (object.size > maximumRecordBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    if (object.customMetadata?.purpose === "private-object-placeholder") {
      yield* io(() => object.body.cancel());
      return;
    }
    const record = yield* Schema.decodeEffect(Schema.fromJsonString(RecordCopy))(
      yield* io(() => object.text())
    );
    if (!matchesHeldScope({ ...input, record })) return yield* new ErasureUnavailable();
    if (record.untilMs <= (yield* Clock.currentTimeMillis)) return;
    yield* io(() =>
      input.configuration.db
        .prepare(`INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written)
    SELECT ?,?,?,?,1 WHERE EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=? AND store_id=? AND data_class=?)
    ON CONFLICT(request_id,store_id,row_ref) DO NOTHING`)
        .bind(
          input.scope.reference,
          record.storeId,
          record.rowRef,
          record.body,
          input.scope.reference,
          record.storeId,
          record.dataClass
        )
        .run()
    );
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const markPurgePending = (input: ArchiveInput): Effect.Effect<void, ErasureUnavailable> =>
  io(() =>
    input.configuration.db.batch([
      input.configuration.db
        .prepare(
          "UPDATE erasure_requests SET purge_pending=1,next_continuation_at_ms=0 WHERE id=? AND user_id=? AND state='ExternalPending'"
        )
        .bind(input.scope.reference, input.scope.userId),
      input.configuration.db
        .prepare(
          "UPDATE erasure_custody_records SET state='Pending',current_event_id=NULL WHERE record_type='current' AND request_id=? AND custodian='Cloudflare'"
        )
        .bind(input.scope.reference),
    ])
  ).pipe(Effect.asVoid);

const matchesHeldScope = (
  input: ArchiveInput & Readonly<{ decision: ErasureDecision; record: typeof RecordCopy.Type }>
): boolean => {
  const disposition = input.decision.dispositions[input.record.dataClass];
  return (
    input.record.userId === input.scope.userId &&
    disposition.action === "Retain" &&
    disposition.retention.untilMs === input.record.untilMs
  );
};

const expiredCopy = (
  input: Readonly<{ object: R2Object; current: number }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const purpose = input.object.customMetadata?.purpose;
    if (purpose === "private-object-erased") return true;
    if (purpose !== "titular-held-record" && purpose !== "private-object-placeholder") {
      return yield* new ErasureUnavailable();
    }
    const expires = yield* Schema.decodeUnknownEffect(Schema.FiniteFromString)(
      input.object.customMetadata?.["expiresAtMs"]
    ).pipe(Effect.mapError(() => new ErasureUnavailable()));
    if (!Number.isSafeInteger(expires)) return yield* new ErasureUnavailable();
    return expires <= input.current;
  });

const verifyCopy = (
  input: Readonly<{ object: R2ObjectBody; encoded: string }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    if (input.object.size > maximumRecordBytes) {
      yield* io(() => input.object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    if ((yield* io(() => input.object.text())) !== input.encoded) {
      return yield* new ErasureUnavailable();
    }
  });
const writablePredecessor = (
  previous: Option.Option<R2ObjectBody>
): Effect.Effect<Option.Option<string>, ErasureUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(previous)) return Option.none();
    yield* io(() => previous.value.body.cancel());
    if (previous.value.customMetadata?.purpose !== "private-object-placeholder") {
      return yield* new ErasureUnavailable();
    }
    return Option.some(previous.value.etag);
  });
