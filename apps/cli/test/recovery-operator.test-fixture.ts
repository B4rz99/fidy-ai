import { Effect, Option, Schema } from "effect";
import { ProcessUnavailable, scopedProcess } from "./process.test-fixture";

const premiseCodec = Schema.fromJsonString(
  Schema.Struct({
    pairingCode: Schema.String,
    backupRecoveryCode: Schema.String,
    assertion: Schema.String,
  })
);
const maximumOutputBytes = 4096;

/** Synthetic terminal/Access input stays on stdin, never argv, environment or a retained file. */
export const invokeRecoveryOperator = Effect.fn(
  function* (premise: typeof premiseCodec.Type) {
    const input = yield* Schema.encodeEffect(premiseCodec)(premise);
    const child = yield* scopedProcess(
      [process.execPath, new URL("./recovery-entry.ts", import.meta.url).pathname],
      undefined,
      new TextEncoder().encode(input)
    );
    let output = "";
    let bytes = 0;
    let chunk = yield* child.read;
    while (Option.isSome(chunk)) {
      bytes += chunk.value.byteLength;
      if (bytes > maximumOutputBytes) return yield* new ProcessUnavailable();
      output += new TextDecoder().decode(chunk.value);
      chunk = yield* child.read;
    }
    return { exitCode: yield* child.exited, output };
  },
  Effect.scoped,
  Effect.timeout("15 seconds")
);
