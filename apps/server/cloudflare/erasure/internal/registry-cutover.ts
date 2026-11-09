import { Clock, Effect, Option, Schema } from "effect";
import { ErasureReference } from "../../../src/core/erasure/contract";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { newId } from "../../secret-material/operations";
import { ErasureGeneration, type ErasureRegistry } from "../contract";
import { generationKey } from "./generation";
import { registryStorage } from "./registry-storage";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync" | "sync">;
type Bucket = Pick<R2Bucket, "get" | "head" | "put" | "delete" | "list">;
type Configuration = Readonly<{ storage: Storage; db: D1Database; bucket: Bucket }>;
const Row = Schema.Struct({
  source: ErasureGeneration,
  source_etag: Schema.String,
  target: ErasureReference,
  phase: Schema.Literals(["prepared", "published"]),
});
const Eligibility = Schema.Struct({
  generation: ErasureGeneration,
  requests: Schema.Literals([0, 1]),
  restore: Schema.Literals([0, 1]),
  members: Schema.Literals([0, 1]),
});
const maximumGenerationBytes = 64;
const purpose = "erasure-registry-transfer";
const io = <Value>(run: () => Promise<Value>): Effect.Effect<Value, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
const row = (storage: Storage): Option.Option<typeof Row.Type> => {
  const value = storage.sql
    .exec("SELECT source,source_etag,target,phase FROM erasure_registry_cutover WHERE singleton=1")
    .toArray()[0];
  if (value === undefined) return Option.none();
  const decoded = Schema.decodeUnknownOption(Row)(value);
  if (Option.isNone(decoded)) throw new ErasureUnavailable();
  return decoded;
};
const source = (
  bucket: Bucket
): Effect.Effect<Readonly<{ object: R2Object; value: string }>, ErasureUnavailable> =>
  Effect.gen(function* () {
    const object = yield* io(() => bucket.get(generationKey));
    if (object === null) return yield* new ErasureUnavailable();
    if (object.size > maximumGenerationBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    return { object, value: yield* io(() => object.text()) };
  });
const prepare = (input: Configuration): Effect.Effect<typeof Row.Type, ErasureUnavailable> =>
  Effect.gen(function* () {
    const captured = yield* source(input.bucket);
    const generation = yield* Schema.decodeEffect(ErasureGeneration)(captured.value);
    const selected = yield* io(() =>
      input.db
        .prepare(`SELECT generation,
    EXISTS(SELECT 1 FROM erasure_requests LIMIT 1) AS requests,
    EXISTS(SELECT 1 FROM erasure_control WHERE kind='restore' LIMIT 1) AS restore,
    EXISTS(SELECT 1 FROM erasure_restore_members LIMIT 1) AS members
    FROM erasure_control WHERE kind='published'`)
        .first()
    );
    const eligibility = yield* Schema.decodeUnknownEffect(Eligibility)(selected);
    if (
      eligibility.generation !== generation ||
      eligibility.requests !== 0 ||
      eligibility.restore !== 0 ||
      eligibility.members !== 0
    ) {
      return yield* new ErasureUnavailable();
    }
    const cases = yield* io(() => input.bucket.list({ prefix: "recovery/cases/", limit: 1 }));
    if (cases.truncated || cases.objects.length !== 0) return yield* new ErasureUnavailable();
    const target = newId(),
      uploaded = yield* Clock.currentTimeMillis;
    return yield* Effect.try({
      try: () =>
        input.storage.transactionSync(() => {
          const existing = row(input.storage);
          if (Option.isSome(existing)) return existing.value;
          if (
            input.storage.sql.exec("SELECT 1 FROM erasure_registry LIMIT 1").toArray().length !== 0
          ) {
            throw new ErasureUnavailable();
          }
          input.storage.sql.exec(
            "INSERT INTO erasure_registry(key,value,etag,uploaded) VALUES(?,?,?,?)",
            generationKey,
            `publishing:${target}`,
            newId(),
            uploaded
          );
          input.storage.sql.exec(
            "INSERT INTO erasure_registry_cutover(singleton,source,source_etag,target,phase) VALUES(1,?,?,?,'prepared')",
            generation,
            captured.object.etag,
            target
          );
          return {
            source: generation,
            source_etag: captured.object.etag,
            target,
            phase: "prepared" as const,
          };
        }),
      catch: () => new ErasureUnavailable(),
    });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const isClaimed = (input: { value: string; object: R2Object; record: typeof Row.Type }): boolean =>
  input.value === `publishing:${input.record.target}:migrating` &&
  input.object.customMetadata?.purpose === purpose &&
  input.object.customMetadata?.sourceGeneration === input.record.source &&
  input.object.customMetadata?.targetGeneration === input.record.target;

const claim = (
  input: Configuration,
  record: typeof Row.Type
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const current = yield* source(input.bucket);
    const pending = `publishing:${record.target}:migrating`;
    if (isClaimed({ ...current, record })) {
      return;
    }
    if (current.value !== record.source || current.object.etag !== record.source_etag) {
      return yield* new ErasureUnavailable();
    }
    const claimed = yield* io(() =>
      input.bucket.put(generationKey, pending, {
        onlyIf: { etagMatches: record.source_etag },
        customMetadata: {
          purpose,
          sourceGeneration: record.source,
          targetGeneration: record.target,
        },
      })
    );
    if (claimed === null) return yield* new ErasureUnavailable();
  });
const publish = (input: Configuration, record: typeof Row.Type, uploaded: number): boolean =>
  input.storage.transactionSync(() => {
    const current = row(input.storage);
    if (Option.isNone(current)) throw new ErasureUnavailable();
    if (current.value.phase === "published") return false;
    const stored = input.storage.sql
      .exec("SELECT value FROM erasure_registry WHERE key=?", generationKey)
      .toArray()[0];
    if (stored?.value !== `publishing:${record.target}`) throw new ErasureUnavailable();
    input.storage.sql.exec(
      "UPDATE erasure_registry SET value=?,etag=?,uploaded=? WHERE key=?",
      record.target,
      newId(),
      uploaded,
      generationKey
    );
    input.storage.sql.exec(
      "UPDATE erasure_registry_cutover SET phase='published' WHERE singleton=1 AND phase='prepared'"
    );
    return true;
  });
const status = (
  input: Configuration,
  registry: ErasureRegistry
): Effect.Effect<"Complete" | "AwaitingRestore", ErasureUnavailable> =>
  Effect.gen(function* () {
    const object = yield* io(() => registry.get(generationKey));
    if (object === null) return yield* new ErasureUnavailable();
    const current = yield* Schema.decodeEffect(ErasureGeneration)(yield* io(() => object.text()));
    const checkpoint = yield* io(() =>
      input.db
        .prepare("SELECT generation FROM erasure_control WHERE kind='published'")
        .first("generation")
    );
    return checkpoint === current ? "Complete" : "AwaitingRestore";
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const migrate = (
  input: Configuration,
  registry: ErasureRegistry
): Effect.Effect<"Complete" | "AwaitingRestore", ErasureUnavailable> =>
  Effect.gen(function* () {
    const existing = yield* Effect.try({
      try: () => row(input.storage),
      catch: () => new ErasureUnavailable(),
    });
    const record = Option.isSome(existing) ? existing.value : yield* prepare(input);
    if (record.phase === "published") return yield* status(input, registry);
    yield* claim(input, record);
    const uploaded = yield* Clock.currentTimeMillis;
    const granted = yield* Effect.try({
      try: () => publish(input, record, uploaded),
      catch: () => new ErasureUnavailable(),
    });
    if (!granted) return yield* status(input, registry);
    yield* io(() => input.storage.sync());
    yield* io(() =>
      input.db
        .prepare(`UPDATE erasure_control SET generation=? WHERE kind='published' AND generation=?
    AND NOT EXISTS(SELECT 1 FROM erasure_requests)
    AND NOT EXISTS(SELECT 1 FROM erasure_control WHERE kind='restore')
    AND NOT EXISTS(SELECT 1 FROM erasure_restore_members)`)
        .bind(record.target, record.source)
        .run()
    );
    return yield* status(input, registry);
  });

export const registryCutover = (
  input: Configuration
): Readonly<{
  registry: ErasureRegistry;
  migrate: Effect.Effect<"Complete" | "AwaitingRestore", ErasureUnavailable>;
}> => {
  const native = registryStorage(input.storage);
  input.storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS erasure_registry_cutover(singleton INTEGER PRIMARY KEY CHECK(singleton=1),source TEXT NOT NULL,source_etag TEXT NOT NULL,target TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN('prepared','published')))"
  );
  const selected = (): ErasureRegistry =>
    Option.exists(row(input.storage), (value) => value.phase === "published")
      ? native
      : input.bucket;
  return {
    registry: {
      get: (key) => selected().get(key),
      head: (key) => selected().head(key),
      put: (key, value, options) => selected().put(key, value, options),
      delete: (key) => selected().delete(key),
      list: (options) => selected().list(options),
    },
    migrate: migrate(input, native),
  };
};
