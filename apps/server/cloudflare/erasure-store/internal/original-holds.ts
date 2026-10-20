import { Clock, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { maximumStatementBytes } from "../../../src/core/ingestion/contract";
import { digestBytes } from "../../secret-material/operations";
import { erasePrivateObject, writePrivateObject } from "../../private-objects/operations";
import {
  type ErasureOriginalConfiguration,
  type ErasureScope,
  ErasureUnavailable,
} from "../contract";
import { ErasureDecision } from "../../../src/core/erasure/contract";

const maximumObjects = 1;
const ObjectRow = Schema.Struct({
  bucket: Schema.Literals(["email", "statement"]),
  key: Schema.String,
});
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
type HoldInput = Readonly<{ configuration: ErasureOriginalConfiguration; scope: ErasureScope }>;
const originalBytes = (
  input: HoldInput & Readonly<{ object: typeof ObjectRow.Type }>
): Effect.Effect<Uint8Array, ErasureUnavailable> =>
  Effect.gen(function* () {
    const source = input.configuration[input.object.bucket];
    if (Option.isNone(source)) return yield* new ErasureUnavailable();
    const object = yield* io(() => source.value.get(input.object.key));
    if (object === null) return yield* new ErasureUnavailable();
    if (
      object.customMetadata?.purpose !==
      (input.object.bucket === "email" ? "forwarded-email" : "statement-original")
    ) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }

    if (object.size > maximumStatementBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    return new Uint8Array(yield* io(() => object.arrayBuffer()));
  });
const matchingCopy = (
  input: Readonly<{ previous: R2Object; bytes: Uint8Array; digest: Uint8Array }>
): boolean =>
  input.previous.customMetadata?.purpose === "titular-held-original" &&
  input.previous.size === input.bytes.byteLength &&
  input.previous.checksums.sha256 !== undefined &&
  Hex.encode(new Uint8Array(input.previous.checksums.sha256)) === Hex.encode(input.digest);
const publishHeldOriginal = (
  input: HoldInput &
    Readonly<{
      bucket: R2Bucket;
      key: string;
      bytes: Uint8Array;
      digest: Uint8Array;
      untilMs: number;
    }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const previous = yield* io(() => input.bucket.head(input.key));
    if (previous !== null && matchingCopy({ ...input, previous })) return;
    if (previous !== null && previous.customMetadata?.purpose !== "private-object-placeholder") {
      return yield* new ErasureUnavailable();
    }
    const predecessor = previous === null ? Option.none<string>() : Option.some(previous.etag);
    yield* writePrivateObject({
      ...input,
      digest: Option.some(input.digest),
      predecessor,
      metadata: { purpose: "titular-held-original", expiresAtMs: String(input.untilMs) },
      authorise: io(() =>
        input.configuration.db
          .prepare(`SELECT count(*) AS approved FROM erasure_requests
      WHERE id=? AND user_id=? AND state='Archiving' AND marker_written=1`)
          .bind(input.scope.reference, input.scope.userId)
          .first<number>("approved")
      ).pipe(Effect.map((approved) => approved === 1)),
    });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const copyOriginal = (
  input: HoldInput & Readonly<{ object: typeof ObjectRow.Type; untilMs: number }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const target = input.configuration.retained;
    if (Option.isNone(target)) return yield* new ErasureUnavailable();
    const tail = input.object.key.split("/").at(-1);
    if (tail === undefined) return yield* new ErasureUnavailable();
    const key = `held/${input.scope.reference}/${input.object.bucket}/${tail}`;
    const previous = yield* io(() => target.value.head(key));
    if (previous === null || !reusableCopy({ object: previous, untilMs: input.untilMs })) {
      const bytes = yield* originalBytes(input);
      const digest = yield* digestBytes(bytes);
      yield* publishHeldOriginal({ ...input, bucket: target.value, key, bytes, digest });
    }

    yield* io(() =>
      input.configuration.db
        .prepare(`UPDATE erasure_objects SET retained_key=?
    WHERE request_id=? AND bucket=? AND object_key=? AND retained_key IS NULL`)
        .bind(key, input.scope.reference, input.object.bucket, input.object.key)
        .run()
    );
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

export const holdOriginals = (input: HoldInput): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* io(() =>
      input.configuration.db
        .prepare(`SELECT decision_json AS decision FROM erasure_requests
    WHERE id=? AND user_id=? AND state='Archiving' AND marker_written=1 AND objects_captured=1`)
        .bind(input.scope.reference, input.scope.userId)
        .first()
    );
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ decision: Schema.fromJsonString(ErasureDecision) })
    )(raw);
    const disposition = row.decision.dispositions.ingestion;
    if (
      disposition.action === "Delete" ||
      disposition.retention.untilMs <= (yield* Clock.currentTimeMillis)
    ) {
      return true;
    }
    const records = yield* io(() =>
      input.configuration.db
        .prepare(
          "SELECT bucket,object_key AS key FROM erasure_objects WHERE request_id=? AND retained_key IS NULL LIMIT ?"
        )
        .bind(input.scope.reference, maximumObjects)
        .all()
    );
    const objects = yield* Schema.decodeUnknownEffect(Schema.Array(ObjectRow))(records.results);
    if (objects.length === 0) return true;
    yield* Effect.forEach(
      objects,
      (object) => copyOriginal({ ...input, object, untilMs: disposition.retention.untilMs }),
      { discard: true }
    );
    return false;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

export const purgeHeldOriginals = (input: HoldInput): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* io(() =>
      input.configuration.db
        .prepare(
          `SELECT decision_json AS decision FROM erasure_requests WHERE id=? AND user_id=? AND state='ExternalPending'`
        )
        .bind(input.scope.reference, input.scope.userId)
        .first()
    );
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ decision: Schema.fromJsonString(ErasureDecision) })
    )(raw);
    const bucket = input.configuration.retained;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const prefix = `held/${input.scope.reference}/`;
    const objects = yield* io(() => bucket.value.list({ prefix, limit: maximumPurgeObjects }));
    if (objects.objects.length === 0) {
      yield* io(() =>
        input.configuration.db
          .prepare(
            "UPDATE erasure_objects SET held_deleted=1 WHERE request_id=? AND EXISTS(SELECT 1 FROM erasure_requests WHERE id=? AND user_id=? AND state='ExternalPending')"
          )
          .bind(input.scope.reference, input.scope.reference, input.scope.userId)
          .run()
      );
      return true;
    }
    const disposition = row.decision.dispositions.ingestion;
    if (
      disposition.action === "Retain" &&
      disposition.retention.untilMs > (yield* Clock.currentTimeMillis)
    ) {
      return false;
    }
    yield* markPurgePending(input);

    yield* Effect.forEach(
      objects.objects,
      (object) => erasePrivateObject({ bucket: bucket.value, key: object.key }),
      { discard: true }
    );
    yield* recordPurge(input);
    return false;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const maximumPurgeObjects = 4;
const recordPurge = (input: HoldInput): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    yield* io(() =>
      input.configuration.db.batch([
        input.configuration.db
          .prepare(
            "UPDATE erasure_requests SET last_erased_at_ms=? WHERE id=? AND user_id=? AND state='ExternalPending'"
          )
          .bind(current, input.scope.reference, input.scope.userId),
        input.configuration.db
          .prepare(
            "UPDATE erasure_custody_records SET state='Pending',current_event_id=NULL WHERE record_type='current' AND request_id=? AND custodian='Cloudflare'"
          )
          .bind(input.scope.reference),
      ])
    );
  });

const markPurgePending = (input: HoldInput): Effect.Effect<void, ErasureUnavailable> =>
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

const reusableCopy = (input: Readonly<{ object: R2Object; untilMs: number }>): boolean =>
  input.object.customMetadata?.purpose === "titular-held-original" &&
  input.object.customMetadata["expiresAtMs"] === String(input.untilMs) &&
  input.object.checksums.sha256 !== undefined &&
  input.object.size > 0 &&
  input.object.size <= maximumStatementBytes;
