import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import type { LocalIngestionEnvironment } from "../contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import { PrivateObjectUnavailable } from "../../private-objects/contract";
import { userPrivateObjectPrefix } from "../../private-objects/operations";
import { UserId } from "../../../src/core/identity/contract";

const Bucket = Schema.Literals(["email", "statement"]);

const Writer = Schema.Struct({ nonce: Schema.String, bucket: Bucket, object_key: Schema.String });

const pageSize = 8;

export const trackOriginalPut = Effect.fn(function* (
  scope: { bucket: R2Bucket; kind: typeof Bucket.Type; user: string },
  { key, bytes, options }: { key: string; bytes: Uint8Array; options: R2PutOptions }
) {
  const { bucket, kind, user } = scope;
  const sql = yield* SqliteClient;
  const nonce = newId();

  const saved = yield* withStoreCapacity("growth")(
    sql`INSERT INTO original_writers(nonce,bucket,object_key) SELECT ${nonce},${kind},${key} FROM users WHERE id=${user} AND NOT EXISTS(SELECT 1 FROM erasure_requests) RETURNING nonce`
  );

  if (saved.length !== 1) return yield* new PrivateObjectUnavailable();

  const output = yield* Effect.tryPromise(() =>
    bucket.put(key, Uint8Array.from(bytes), {
      ...options,
      customMetadata: { ...options.customMetadata, writer: nonce },
    })
  );

  yield* sql`DELETE FROM original_writers WHERE nonce=${nonce}`;

  return output;
});

export const settleObservedOriginal = Effect.fn(function* (
  bucket: typeof Bucket.Type,
  key: string,
  observed: Option.Option<R2Object>
) {
  const nonce = Option.flatMap(observed, (object) =>
    Option.fromUndefinedOr(object.customMetadata?.writer)
  );

  if (Option.isNone(nonce)) return;
  const sql = yield* SqliteClient;
  yield* sql`DELETE FROM original_writers WHERE nonce=${nonce.value} AND bucket=${bucket} AND object_key=${key}`;
});

export const settleBeforeDisposal = Effect.fn(function* (
  kind: typeof Bucket.Type,
  bucket: R2Bucket,
  row: { user_id: string; object_key: string }
) {
  const user = yield* Schema.decodeEffect(UserId)(row.user_id);

  if (!row.object_key.startsWith(userPrivateObjectPrefix(user))) {
    return yield* new PrivateObjectUnavailable();
  }

  const sql = yield* SqliteClient;

  if (
    (yield* sql`SELECT 1 FROM original_writers WHERE bucket=${kind} AND object_key=${row.object_key} LIMIT 1`)
      .length === 0
  ) {
    return;
  }

  const head = yield* Effect.tryPromise(() => bucket.head(row.object_key));
  yield* settleObservedOriginal(kind, row.object_key, Option.fromNullOr(head));
});

export const reconcileOriginals = Effect.fn(function* (
  user: UserId,
  env: LocalIngestionEnvironment
) {
  const sql = yield* SqliteClient;

  const writers = yield* Schema.decodeUnknownEffect(Schema.Array(Writer))(
    yield* sql`SELECT nonce,bucket,object_key FROM original_writers ORDER BY checked_ms,nonce LIMIT ${pageSize}`
  );

  yield* Effect.forEach(
    writers,
    Effect.fnUntraced(function* (writer) {
      if (!writer.object_key.startsWith(userPrivateObjectPrefix(user))) {
        return yield* new PrivateObjectUnavailable();
      }

      const bucket = writer.bucket === "email" ? env.EMAIL_BUCKET : env.STATEMENT_STAGING_BUCKET;
      const head = yield* Effect.tryPromise(() => bucket.head(writer.object_key));

      if (head?.customMetadata?.writer === writer.nonce) {
        yield* sql`DELETE FROM original_writers WHERE nonce=${writer.nonce}`;
      } else {
        yield* sql`UPDATE original_writers SET checked_ms=coalesce((SELECT max(checked_ms) FROM original_writers),0)+1 WHERE nonce=${writer.nonce}`;
      }
    }),
    { discard: true }
  );
});
