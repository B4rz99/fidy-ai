import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Result, Schema } from "effect";
import { Hex } from "effect/encoding";
import { SampleArtifact } from "../../../src/core/ingestion/contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import type { LocalIngestionEnvironment } from "../contract";
import { sampleAuthority } from "./sample-authority";

type Buckets = Pick<LocalIngestionEnvironment, "EMAIL_BUCKET" | "SAMPLE_BUCKET">;

const sampleKey = (id: string): string => "samples/" + id;

const fenceKey = (id: string): string => "sample-withdrawals/" + id;

export const sampleRetryMs = 60_000;

const maxReservations = 4;

const placeholder = "sample-placeholder";

const anonymous = "anonymous-ingest-sample";

const rowSchema = Schema.Struct({
  user_id: Schema.String,
  artifact: Schema.String,
  digest: Schema.String,
});

export const withdrawArtifact = Effect.fn(function* (
  id: string,
  buckets: Buckets,
  evidence: Readonly<{ issuer: string; operator: string; at: number }>
) {
  const key = sampleKey(id);
  const bytes = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(evidence);
  yield* Effect.tryPromise(() =>
    buckets.EMAIL_BUCKET.put(fenceKey(id), bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
    })
  );
  yield* Effect.tryPromise(() => buckets.SAMPLE_BUCKET.delete(key));
});

export const isWithdrawnSample = Effect.fn(function* (id: string, buckets: Buckets) {
  return (yield* Effect.tryPromise(() => buckets.EMAIL_BUCKET.head(fenceKey(id)))) !== null;
});

const settleReservation = Effect.fn(function* (id: string, nonce: string) {
  const sql = yield* SqliteClient;
  yield* withStoreCapacity("required")(
    sql`DELETE FROM ingest_sample_reservations WHERE sample_id=${id} AND nonce=${nonce}`
  );
});

const createReservation = Effect.fn(function* (id: string, buckets: Buckets) {
  const sql = yield* SqliteClient;
  const nonce = newId();

  const claim = yield* withStoreCapacity("required")(
    sql`INSERT INTO ingest_sample_reservations SELECT ${nonce},sample_id FROM ingest_sample_decisions WHERE sample_id=${id} AND phase='approved' AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=ingest_sample_decisions.user_id) AND (SELECT count(*) FROM ingest_sample_reservations WHERE sample_id=${id})<${maxReservations} RETURNING nonce`
  );

  if (claim.length === 0) return null;

  const object = yield* Effect.tryPromise(() =>
    buckets.SAMPLE_BUCKET.put(sampleKey(id), nonce, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { purpose: placeholder, nonce },
    })
  );

  yield* settleReservation(id, nonce);

  return object;
});

const settleObservedReservation = Effect.fn(function* (
  id: string,
  observed: Option.Option<R2Object>
) {
  if (Option.isNone(observed)) return;
  const nonce = observed.value.customMetadata?.nonce;

  if (observed.value.customMetadata?.purpose === placeholder && nonce !== undefined) {
    yield* settleReservation(id, nonce);
  }
});

const drainRemoved = Effect.fn(function* (id: string, buckets: Buckets) {
  const sql = yield* SqliteClient;
  const observed = yield* Effect.tryPromise(() => buckets.SAMPLE_BUCKET.head(sampleKey(id)));
  yield* settleObservedReservation(id, Option.fromNullOr(observed));
  yield* Effect.tryPromise(() =>
    buckets.EMAIL_BUCKET.put(fenceKey(id), '{"erased":true}', { onlyIf: { etagDoesNotMatch: "*" } })
  );

  const [writers] =
    yield* sql`SELECT count(*) AS n FROM ingest_sample_reservations WHERE sample_id=${id}`;

  if (observed !== null || writers?.n === 0) {
    yield* Effect.tryPromise(() => buckets.SAMPLE_BUCKET.delete(sampleKey(id)));
  }

  if (writers?.n !== 0) return;
  yield* withStoreCapacity("required")(
    sql`UPDATE ingest_sample_decisions SET phase='withdrawn',due_ms=NULL WHERE sample_id=${id} AND phase='removing'`
  );
});

const remove = Effect.fn(function* (id: string, buckets: Buckets) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const claimed = yield* withStoreCapacity("required")(
    sql`UPDATE ingest_sample_decisions SET phase='removing',artifact=NULL,due_ms=${now + sampleRetryMs} WHERE sample_id=${id} AND phase IN ('approved','removing') RETURNING sample_id`
  );

  if (claimed.length > 0) yield* drainRemoved(id, buckets);

  return false;
});

const approved = Effect.fn(function* (id: string, user: string) {
  const sql = yield* SqliteClient;

  return (
    (yield* sampleAuthority(user)) &&
    (yield* sql`SELECT 1 FROM ingest_sample_decisions WHERE sample_id=${id} AND phase='approved'`)
      .length === 1
  );
});

const finish = Effect.fn(function* (id: string, user: string, buckets: Buckets) {
  const sql = yield* SqliteClient;

  const settled = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      if (!(yield* approved(id, user))) return false;

      return (
        (yield* sql`UPDATE ingest_sample_decisions SET phase='published',artifact=NULL,due_ms=NULL WHERE sample_id=${id} AND phase='approved' AND NOT EXISTS(SELECT 1 FROM ingest_sample_reservations WHERE sample_id=${id}) RETURNING sample_id`)
          .length === 1
      );
    })
  );

  if (settled) return true;

  if (!(yield* sampleAuthority(user))) return yield* remove(id, buckets);

  return false;
});

export const offerSample = Effect.fn(function* (id: string, buckets: Buckets) {
  const sql = yield* SqliteClient;

  const [raw] =
    yield* sql`SELECT user_id,artifact,digest,phase FROM ingest_sample_decisions WHERE sample_id=${id}`;

  if (raw?.phase === "removing") return yield* remove(id, buckets);

  if (raw?.phase !== "approved") return raw?.phase === "published";

  return yield* publishApproved(id, buckets, yield* Schema.decodeUnknownEffect(rowSchema)(raw));
});

const matchesApproval = (object: R2Object, digest: string): boolean =>
  object.checksums.sha256 !== undefined &&
  Hex.encode(new Uint8Array(object.checksums.sha256)) === digest;

const completePayload = Effect.fn(function* (
  id: string,
  buckets: Buckets,
  { row, current }: { row: typeof rowSchema.Type; current: R2Object }
) {
  if (current.customMetadata?.purpose !== placeholder || !(yield* approved(id, row.user_id))) {
    return false;
  }

  yield* Schema.decodeEffect(Schema.fromJsonString(SampleArtifact), { onExcessProperty: "error" })(
    row.artifact
  );

  const written = yield* Effect.tryPromise(() =>
    buckets.SAMPLE_BUCKET.put(sampleKey(id), row.artifact, {
      onlyIf: { etagMatches: current.etag },
      sha256: row.digest,
      customMetadata: { purpose: anonymous },
    })
  );

  return written === null ? false : yield* finish(id, row.user_id, buckets);
});

const publishApproved = Effect.fn(function* (
  id: string,
  buckets: Buckets,
  row: typeof rowSchema.Type
) {
  if (!(yield* sampleAuthority(row.user_id))) return yield* remove(id, buckets);
  const key = sampleKey(id);
  const previous = yield* Effect.tryPromise(() => buckets.SAMPLE_BUCKET.head(key));
  const current = previous ?? (yield* createReservation(id, buckets));

  if (current === null) return false;
  yield* settleObservedReservation(id, Option.some(current));

  if (yield* isWithdrawnSample(id, buckets)) return yield* remove(id, buckets);

  if (current.customMetadata?.purpose === anonymous) {
    return matchesApproval(current, row.digest) && (yield* finish(id, row.user_id, buckets));
  }

  return yield* completePayload(id, buckets, { row, current });
});

const maximumArtifactBytes = 1024;

const matchingSampleObject = (object: R2Object, digest: string): boolean =>
  object.size <= maximumArtifactBytes &&
  object.customMetadata?.purpose === anonymous &&
  Object.keys(object.customMetadata).length === 1 &&
  matchesApproval(object, digest);

const safePublication = Effect.fn(function* (id: string, digest: string, buckets: Buckets) {
  if (yield* isWithdrawnSample(id, buckets)) return false;
  const object = yield* Effect.tryPromise(() => buckets.SAMPLE_BUCKET.get(sampleKey(id)));

  if (object === null) return false;

  if (!matchingSampleObject(object, digest)) {
    yield* Effect.tryPromise(() => object.body.cancel());

    return false;
  }

  const text = yield* Effect.tryPromise(() => object.text());
  const codec = Schema.fromJsonString(SampleArtifact);
  const sample = Schema.decodeOption(codec, { onExcessProperty: "error" })(text);

  return Option.isSome(sample) && (yield* Schema.encodeEffect(codec)(sample.value)) === text;
});

export const inspectPublishedSamples = Effect.fn(function* (
  user: string,
  buckets: Buckets,
  now: number
) {
  const sql = yield* SqliteClient;

  const rows =
    yield* sql`SELECT sample_id,digest FROM ingest_sample_decisions WHERE user_id=${user} AND phase='published' AND sample_id>(SELECT sample_cursor FROM erasure_requests WHERE user_id=${user}) ORDER BY sample_id LIMIT 8`;

  yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (raw) {
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ sample_id: Schema.String.check(Schema.isUUID()), digest: Schema.String })
      )(raw);

      const safe = yield* safePublication(row.sample_id, row.digest, buckets);
      yield* withStoreCapacity("required")(
        Effect.gen(function* () {
          if (!safe) {
            yield* sql`UPDATE ingest_sample_decisions SET phase='removing',due_ms=${now} WHERE sample_id=${row.sample_id} AND phase='published'`;
          }

          yield* sql`UPDATE erasure_requests SET sample_cursor=${row.sample_id} WHERE user_id=${user} AND state='Draining' AND sample_cursor<${row.sample_id}`;
        })
      );
    }),
    { discard: true }
  );
});

export const recoverSamples = Effect.fn(function* (now: number, buckets: Buckets) {
  const sql = yield* SqliteClient;

  const rows = yield* withStoreCapacity("required")(
    sql`UPDATE ingest_sample_decisions SET due_ms=${now + sampleRetryMs} WHERE sample_id IN(SELECT sample_id FROM ingest_sample_decisions WHERE due_ms<=${now} ORDER BY due_ms LIMIT 8) RETURNING sample_id`
  );

  const outcomes = yield* Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(Schema.String)(row.sample_id).pipe(
      Effect.flatMap((id) => offerSample(id, buckets)),
      Effect.result
    )
  );

  return { attempted: rows.length, failed: outcomes.filter(Result.isFailure).length };
});
