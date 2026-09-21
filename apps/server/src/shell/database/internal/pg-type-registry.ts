import { PgTypes } from "@effect/sql-pg";
import { Result } from "effect";

/**
 * OIDs PostgreSQL assigns to `regclass` and its one-dimensional array in `pg_type`.
 * They are catalog constants, not defaults for user-defined types.
 */
const regclassOid = 2205;
const regclassArrayOid = 2210;

const unsignedInt32Max = 4294967295;

/** Reads one relation OID, whose binary encoding is a network-order unsigned 32-bit integer. */
const decodeRegclass = (bytes: Uint8Array): Result.Result<number, PgTypes.CodecError> =>
  bytes.byteLength === 4
    ? Result.succeed(
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)
      )
    : Result.fail(new PgTypes.CodecError({ message: "Expected 4 bytes for regclass" }));

const encodeRegclass = (value: number): Result.Result<Uint8Array, PgTypes.CodecError> => {
  if (!Number.isInteger(value) || value < 0 || value > unsignedInt32Max) {
    return Result.fail(new PgTypes.CodecError({ message: "Expected an unsigned 32-bit regclass" }));
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return Result.succeed(bytes);
};

/**
 * Binary codec for `regclass`, whose representation is the relation's unsigned 32-bit OID and is
 * therefore identical to `oid`'s. The published `@effect/sql-pg` rc.116 catalogue omits it although
 * Effect's own Migrator probes its ledger table with `select $1::regclass`; the unregistered-OID
 * fallback then tries to read that OID as UTF-8 text, which closes the connection. The vendored
 * Effect snapshot registers `regclass` next to `oid`; drop this registry once the published
 * catalogue carries the same registration.
 *
 * Exported so the database codec tests can pin the OID representation and the boundary validation
 * that queries never reach.
 */
export const regclassCodec: PgTypes.Codec<number> = {
  encode: encodeRegclass,
  decode: decodeRegclass,
};

const makePgTypeRegistry = (): PgTypes.Registry => {
  const registry = PgTypes.makeRegistry();
  registry.register(regclassOid, regclassCodec, { arrayOid: regclassArrayOid });
  return registry;
};

/**
 * Codecs every Fidy PostgreSQL pool must install, beyond the driver's built-in
 * catalogue. Shared because registration is fixed at construction and the pools only
 * read from it.
 */
export const pgTypeRegistry: PgTypes.Registry = makePgTypeRegistry();
