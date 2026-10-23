import { Effect, Schema } from "effect";
import { Hex } from "effect/encoding";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import {
  documentedSqlBlock,
  installHistoricalErasureStorage,
} from "../schema-cutover.test-fixture";

const originalEmailDigest = (historyCase: string, sha256: string): string =>
  historyCase === "email-digest-mismatch" ? "d".repeat(64) : sha256;

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const user = "10000000-0000-4000-8000-000000000101";
const other = "10000000-0000-4000-8000-000000000102";
const emailId = "10000000-0000-4000-8000-000000000201";
const statementId = "10000000-0000-4000-8000-000000000202";
const originalMetadata = {
  email: { purpose: "forwarded-email", expiresAtMs: "86400017" },
  statement: { purpose: "statement-original", expiresAtMs: "86400019" },
} as const;
type FileMove = Readonly<{
  kind: "email" | "statement";
  oldKey: string;
  newKey: string;
  sha256: string;
}>;
const copyOriginalFiles = Effect.fn(function* ({
  bucket,
  manifest,
  bytes,
  digest,
  corrupt,
}: Readonly<{
  bucket: R2Bucket;
  manifest: ReadonlyArray<FileMove>;
  bytes: Uint8Array;
  digest: ArrayBuffer;
  corrupt: boolean;
}>) {
  for (const object of manifest) {
    const source = yield* Effect.tryPromise(() => bucket.get(object.oldKey));
    if (source === null) {
      return yield* Effect.die("Missing original file");
    }
    const sourceBytes = yield* Effect.tryPromise(() => source.arrayBuffer());
    expect(new Uint8Array(sourceBytes)).toEqual(bytes);
    const copied = yield* Effect.result(
      Effect.tryPromise(() =>
        bucket.put(object.newKey, corrupt ? "changed private bytes" : sourceBytes, {
          onlyIf: { etagDoesNotMatch: "*" },
          customMetadata: source.customMetadata,
          sha256: digest,
        })
      )
    );
    if (corrupt) {
      expect(copied._tag).toBe("Failure");
      expect(yield* Effect.tryPromise(() => bucket.head(object.newKey))).toBeNull();
      return false;
    }
    expect(copied._tag).toBe("Success");
    const target = yield* Effect.tryPromise(() => bucket.get(object.newKey));
    if (target === null) {
      return yield* Effect.die("Missing copied file");
    }
    expect(target.customMetadata).toEqual(originalMetadata[object.kind]);
    const copiedBytes = yield* Effect.tryPromise(() => target.arrayBuffer());
    const hash = yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", copiedBytes));
    expect(Hex.encode(new Uint8Array(hash))).toBe(object.sha256);
  }
  return true;
});

it.each([
  "valid",
  "foreign-owner",
  "incomplete-manifest",
  "missing-fields",
  "missing-owner",
  "wrong-field-type",
  "email-digest-mismatch",
  "changed-content",
  "interruption",
])(
  "preserves original file integrity and exact owner rows through offline prefix cutover and inverse: %s",
  (historyCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
        yield* Effect.tryPromise(() => installTestSchema({ db }));
        yield* Effect.tryPromise(() => installHistoricalErasureStorage(db));
        const bytes = new TextEncoder().encode("original private bytes");
        const digest = yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", bytes));
        const sha256 = Hex.encode(new Uint8Array(digest));
        const originalKeys = [
          `email/v1/${emailId}`,
          `staging/statement/v1/${"a".repeat(64)}`,
        ] as const;
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','UTC',17),(?,'CO','es-CO','UTC',17)"
              )
              .bind(user, other),
            db
              .prepare(
                "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES('processing_grant','10000000-0000-4000-8000-000000000301',?,'{}','disclosed','accepted',0,0)"
              )
              .bind(user),
            db
              .prepare(
                "INSERT INTO forwarded_email_receipts(rowid,id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms) VALUES(17,?,?,?, ?,?,'queued',17,86400017)"
              )
              .bind(
                emailId,
                user,
                originalEmailDigest(historyCase, sha256),
                originalKeys[0],
                bytes.byteLength
              ),
            db
              .prepare(
                "INSERT INTO statement_staging_objects(rowid,id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms,source_format) VALUES(83,?,?,?,?,?,'available',19,86400019,'csv')"
              )
              .bind(statementId, other, originalKeys[1], bytes.byteLength, sha256),
          ])
        );
        const manifest = [
          {
            kind: "email",
            id: emailId,
            userId: user,
            oldKey: originalKeys[0],
            newKey: `users/${user}/${originalKeys[0]}`,
            byteLength: bytes.byteLength,
            sha256,
          },
          {
            kind: "statement",
            id: statementId,
            userId: other,
            oldKey: originalKeys[1],
            newKey: `users/${other}/${originalKeys[1]}`,
            byteLength: bytes.byteLength,
            sha256,
          },
        ] as const;
        for (const object of manifest) {
          yield* Effect.tryPromise(() =>
            bucket.put(object.oldKey, bytes, {
              sha256: digest,
              customMetadata: originalMetadata[object.kind],
            })
          );
        }
        const read = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT rowid,* FROM forwarded_email_receipts ORDER BY rowid"),
            db.prepare("SELECT rowid,* FROM statement_staging_objects ORDER BY rowid"),
          ]);
        const original = yield* Effect.tryPromise(read);
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const mapped =
          historyCase === "foreign-owner"
            ? manifest.map((object) => ({ ...object, userId: other }))
            : manifest;
        const malformed = new Map<string, Schema.Json>([
          ["incomplete-manifest", mapped.slice(0, 1)],
          ["missing-fields", manifest.map((object) => ({ kind: object.kind, id: "nonexistent" }))],
          ["missing-owner", manifest.map((object) => ({ ...object, id: "nonexistent" }))],
          [
            "wrong-field-type",
            manifest.map((object) => ({ ...object, byteLength: String(object.byteLength) })),
          ],
        ]);
        const selected = malformed.get(historyCase) ?? mapped;
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(selected);
        const copied = yield* copyOriginalFiles({
          bucket,
          manifest,
          bytes,
          digest,
          corrupt: historyCase === "changed-content",
        });
        if (!copied) {
          expect((yield* Effect.tryPromise(read)).map((result) => result.results)).toEqual(
            original.map((result) => result.results)
          );
          return;
        }
        const block = (part: string): ReadonlyArray<string> =>
          documentedSqlBlock({ guide, marker: "user-file-prefix-" + part });
        const result = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              ...block("guard").map((sql) => db.prepare(sql).bind(encoded)),
              ...block("copy").map((sql) => db.prepare(sql)),
              ...(historyCase === "interruption"
                ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupt_user_files',0)")]
                : []),
            ])
          )
        );
        if (historyCase !== "valid") {
          expect(result._tag).toBe("Failure");
          expect((yield* Effect.tryPromise(read)).map((result) => result.results)).toEqual(
            original.map((result) => result.results)
          );
          for (const object of manifest) {
            expect(
              yield* Effect.tryPromise(() =>
                bucket.get(object.oldKey).then((value) => value?.text())
              )
            ).toBe("original private bytes");
          }
          return;
        }
        expect(result._tag).toBe("Success");
        const converted = yield* Effect.tryPromise(read);
        expect(converted.map((result) => result.results)).toMatchObject([
          [{ object_key: manifest[0].newKey }],
          [{ object_key: manifest[1].newKey }],
        ]);
        yield* Effect.tryPromise(() => bucket.delete(manifest.map((object) => object.oldKey)));
        expect(
          (yield* Effect.tryPromise(() => bucket.list({ prefix: `users/${user}/`, limit: 1 })))
            .objects
        ).toHaveLength(1);
        expect(
          (yield* Effect.tryPromise(() => bucket.list({ prefix: `users/${other}/`, limit: 1 })))
            .objects
        ).toHaveLength(1);
        // Restore verified bytes before changing the exact original pointers back.
        for (const object of manifest) {
          const restored = yield* Effect.tryPromise(() =>
            bucket.put(object.oldKey, bytes, {
              onlyIf: { etagDoesNotMatch: "*" },
              customMetadata: originalMetadata[object.kind],
              sha256: digest,
            })
          );
          expect(restored).not.toBeNull();
        }
        const originalManifest = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
          manifest
        );
        yield* Effect.tryPromise(() =>
          db.batch(
            block("rollback-copy").map((sql) =>
              db.prepare(sql).bind(originalManifest, originalManifest)
            )
          )
        );
        expect((yield* Effect.tryPromise(read)).map((result) => result.results)).toEqual(
          original.map((result) => result.results)
        );
        expect(
          (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);
      })
    )
);
