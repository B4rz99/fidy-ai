import { Schema } from "effect";
import { ProtectedCommand } from "../contract";

const values = Schema.decodeUnknownSync(ProtectedCommand.fields.params);

const viewBytes = (value: ArrayBufferView): ReadonlyArray<number> => {
  if (value instanceof DataView) return [];
  const length = Schema.decodeUnknownSync(Schema.Int)(Reflect.get(value, "length"));
  const numbers = Schema.decodeUnknownSync(Schema.Array(Schema.Finite))(
    Array.from({ length }, (_, index): unknown => Reflect.get(value, index))
  );
  return Array.from(Uint8Array.from(numbers));
};

/** Native bind validation must succeed first. Snapshot the accepted bindings without retaining their buffers. */
export const commandBindings = (bound: unknown[]): typeof ProtectedCommand.Type.params =>
  values(
    bound.map((value) => {
      if (typeof value === "number" && !Number.isFinite(value)) return null;
      if (Array.isArray(value)) return Array.from(new Uint8Array(value));
      if (typeof value === "boolean") return value ? 1 : 0;
      if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) return viewBytes(value);
      return value;
    })
  );
