import { Option, Schema } from "effect";
import { type AuthoritativeStoreEnvironment, SqliteStoreRequest } from "../contract";
import { remoteDatabase } from "./remote";

const Manifest = SqliteStoreRequest.fields.manifest;
const unavailable = (): never => {
  throw new Error("Authoritative store configuration unavailable");
};
/** A trusted composition chooses exactly one physical database; there is no read/write fallback. */
export const resolveDatabase = (environment: AuthoritativeStoreEnvironment): D1Database => {
  const { DB, SQLITE_STORE, SQLITE_STORE_MANIFEST, SQLITE_STORE_EPOCH } = environment;
  if (SQLITE_STORE === undefined) {
    return DB !== undefined &&
      SQLITE_STORE_MANIFEST === undefined &&
      SQLITE_STORE_EPOCH === undefined
      ? DB
      : unavailable();
  }
  if (DB !== undefined) return unavailable();
  const manifest = Schema.decodeUnknownOption(Manifest)(SQLITE_STORE_MANIFEST);
  if (Option.isNone(manifest)) return unavailable();
  const epoch = Schema.decodeUnknownOption(SqliteStoreRequest.fields.epoch)(SQLITE_STORE_EPOCH);
  if (Option.isNone(epoch)) return unavailable();
  return remoteDatabase({
    store: SQLITE_STORE.getByName("authoritative-v1"),
    manifest: manifest.value,
    epoch: epoch.value,
  });
};
