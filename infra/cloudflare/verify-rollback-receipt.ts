/// <reference types="bun-types" />

import { Effect, Option, Schema } from "effect";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/smoke";
import { RollbackReceipt } from "./release-rollback";

const SourceRun = Schema.Struct({
  name: Schema.Literal("Deploy Production"),
  head_branch: Schema.Literal("trunk"),
  head_sha: SmokeIdentity.fields.gitRevision,
  event: Schema.Literal("push"),
});

/** Refuse a downloaded receipt that does not belong to an automatic trunk Production run. */
export const verifyRollbackReceipt = (input: { run: unknown; receipt: unknown }): boolean => {
  const source = Schema.decodeUnknownOption(SourceRun)(input.run);
  const captured = Schema.decodeUnknownOption(RollbackReceipt)(input.receipt);
  return (
    Option.isSome(source) &&
    Option.isSome(captured) &&
    source.value.head_sha === captured.value.release.snapshot.revision
  );
};

if (import.meta.main) {
  const maxBytes = 100_000;
  const readJson = (path: string): Effect.Effect<unknown, string> =>
    Effect.gen(function* () {
      const file = Bun.file(path);
      if (file.size > maxBytes) return yield* Effect.fail("Receipt exceeds limit");
      const text = yield* Effect.tryPromise({
        try: () => file.text(),
        catch: () => "Unreadable receipt",
      });
      const decoded = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text);
      if (Option.isNone(decoded)) return yield* Effect.fail("Invalid receipt JSON");
      return decoded.value;
    });
  const program = Effect.gen(function* () {
    const sourcePath = Option.fromUndefinedOr(process.argv[2]);
    const receiptPath = Option.fromUndefinedOr(process.argv[3]);
    if (Option.isNone(sourcePath) || Option.isNone(receiptPath)) {
      return yield* Effect.fail("Missing receipt path");
    }
    const run = yield* readJson(sourcePath.value);
    const receipt = yield* readJson(receiptPath.value);
    if (!verifyRollbackReceipt({ run, receipt })) return yield* Effect.fail("Untrusted receipt");
  });
  Effect.runPromise(program).then(
    () => process.stdout.write("Captured release receipt verified.\n"),
    () => {
      process.stderr.write("Manual rollback receipt rejected; Worker traffic unchanged.\n");
      process.exitCode = 1;
    }
  );
}
