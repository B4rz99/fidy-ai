import { registryBody, registryObject } from "./registry-object";
import { Clock, Effect, Option, Schema } from "effect";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { newId } from "../../secret-material/operations";
import type { ErasureRegistry } from "../contract";
import { checkRegistryKey, checkRegistryValue } from "./registry-value";

const casesPrefix = "recovery/cases/";
const maximumPage = 32;
const maximumCursorLength = 512;
const encoder = new TextEncoder();
const Row = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  etag: Schema.String,
  uploaded: Schema.Int,
});
const Cursor = Schema.Struct({ prefix: Schema.String, after: Schema.String });
const Conditions = Schema.Struct({
  etagMatches: Schema.optionalKey(Schema.String),
  etagDoesNotMatch: Schema.optionalKey(Schema.String),
});
const pageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumPage }));

const decode = <Value extends Schema.ConstraintDecoder<unknown>>(
  schema: Value,
  value: unknown
): Value["Type"] => {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value);
  if (Option.isNone(decoded)) throw new ErasureUnavailable();
  return decoded.value;
};
const matches = (
  current: Option.Option<typeof Row.Type>,
  condition: typeof Conditions.Type
): boolean => {
  const matching =
    condition.etagMatches === undefined ||
    Option.exists(
      current,
      (row) => condition.etagMatches === "*" || row.etag === condition.etagMatches
    );
  const excluded =
    condition.etagDoesNotMatch !== undefined &&
    Option.exists(
      current,
      (row) => condition.etagDoesNotMatch === "*" || row.etag === condition.etagDoesNotMatch
    );
  return matching && !excluded;
};

const objectMetadata = (row: typeof Row.Type): R2Object =>
  registryObject({ ...row, size: encoder.encode(row.value).byteLength });

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync" | "sync">;
const find = (storage: Storage, key: string): Option.Option<typeof Row.Type> => {
  checkRegistryKey(key);
  const row = storage.sql
    .exec("SELECT key,value,etag,uploaded FROM erasure_registry WHERE key=?", key)
    .toArray()[0];
  return row === undefined ? Option.none() : Option.some(decode(Row, row));
};
const bodyObject = (row: typeof Row.Type): R2ObjectBody => {
  checkRegistryValue({ key: row.key, value: row.value });
  return registryBody({ object: objectMetadata(row), value: row.value });
};

const put = (
  storage: Storage,
  input: Readonly<{ key: string; value: string; options: Parameters<ErasureRegistry["put"]>[2] }>
): ReturnType<ErasureRegistry["put"]> =>
  Promise.resolve().then(() => {
    const { key, value, options } = input;
    checkRegistryKey(key);
    checkRegistryValue({ key, value });
    const condition = decode(Conditions, options?.onlyIf ?? {});
    const written = storage.transactionSync(() => {
      if (!matches(find(storage, key), condition)) return null;
      const etag = newId(),
        uploaded = Effect.runSync(Clock.currentTimeMillis);
      storage.sql.exec(
        "INSERT INTO erasure_registry(key,value,etag,uploaded) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,etag=excluded.etag,uploaded=excluded.uploaded",
        key,
        value,
        etag,
        uploaded
      );
      return objectMetadata({ key, value, etag, uploaded });
    });
    // Storage sync confirms publication before a caller can checkpoint a separate database.
    // https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#sync
    return storage.sync().then(() => written);
  });
const afterKey = (
  options: NonNullable<Parameters<ErasureRegistry["list"]>[0]>,
  prefix: string
): string => {
  if (options.cursor === undefined) return "";
  if (options.cursor.length > maximumCursorLength) throw new ErasureUnavailable();
  const cursor = decode(Schema.fromJsonString(Cursor), options.cursor);
  checkRegistryKey(cursor.after);
  if (cursor.prefix !== prefix || !cursor.after.startsWith(prefix)) throw new ErasureUnavailable();
  return cursor.after;
};
const list = (
  storage: Storage,
  options: NonNullable<Parameters<ErasureRegistry["list"]>[0]>
): ReturnType<ErasureRegistry["list"]> =>
  Promise.resolve().then(() => {
    const limit = decode(pageLimit, options.limit ?? maximumPage),
      prefix = options.prefix ?? "";
    if (prefix !== "" && prefix !== casesPrefix) throw new ErasureUnavailable();
    const rows = storage.sql
      .exec(
        "SELECT key,value,etag,uploaded FROM erasure_registry WHERE key>? AND key>=? AND key<? ORDER BY key LIMIT ?",
        afterKey(options, prefix),
        prefix,
        prefix === "" ? "recovery0" : "recovery/cases0",
        limit + 1
      )
      .toArray()
      .map((row) => decode(Row, row));
    const objects = rows.slice(0, limit).map(objectMetadata);
    if (rows.length <= limit) return { objects, delimitedPrefixes: [], truncated: false };
    const last = objects.at(-1);
    if (last === undefined) throw new ErasureUnavailable();
    return {
      objects,
      delimitedPrefixes: [],
      truncated: true,
      cursor: Schema.encodeSync(Schema.fromJsonString(Cursor))({ prefix, after: last.key }),
    };
  });
export const registryStorage = (storage: Storage): ErasureRegistry => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS erasure_registry(key TEXT PRIMARY KEY,value TEXT NOT NULL,etag TEXT NOT NULL,uploaded INTEGER NOT NULL)"
  );
  return {
    get: (key) =>
      Promise.resolve().then(() =>
        Option.match(find(storage, key), { onNone: () => null, onSome: bodyObject })
      ),
    head: (key) =>
      Promise.resolve().then(() =>
        Option.match(find(storage, key), { onNone: () => null, onSome: objectMetadata })
      ),
    put: (key, value, options) => put(storage, { key, value, options }),
    delete: (key) =>
      Promise.resolve().then(() => {
        checkRegistryKey(key);
        storage.sql.exec("DELETE FROM erasure_registry WHERE key=?", key);
        return storage.sync();
      }),
    list: (options) => list(storage, options),
  };
};
