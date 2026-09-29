/// <reference types="bun-types" />

import { Option, Schema } from "effect";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/smoke";
import { RollbackReceipt } from "./release-rollback";

const SourceRun = Schema.Struct({
  name: Schema.Literal("Deploy Production"),
  head_branch: Schema.Literal("trunk"),
  head_sha: SmokeIdentity.fields.gitRevision,
  event: Schema.Literal("push"),
});

/** Refuse a downloaded receipt that does not belong to an automatic trunk Production run. */
export const verifyRollbackReceipt = (run: unknown, receipt: unknown): boolean => {
  const source = Schema.decodeUnknownOption(SourceRun)(run);
  const captured = Schema.decodeUnknownOption(RollbackReceipt)(receipt);
  return (
    Option.isSome(source) &&
    Option.isSome(captured) &&
    source.value.head_sha === captured.value.release.snapshot.revision
  );
};

if (import.meta.main) {
  const maxBytes = 100_000;
  const readJson = async (path: string): Promise<unknown> => {
    const file = Bun.file(path);
    if (file.size > maxBytes) throw Error("Receipt exceeds limit");
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(
      await file.text()
    );
    if (Option.isNone(decoded)) throw Error("Invalid receipt JSON");
    return decoded.value;
  };
  try {
    const sourcePath = Option.fromUndefinedOr(process.argv[2]);
    const receiptPath = Option.fromUndefinedOr(process.argv[3]);
    if (Option.isNone(sourcePath) || Option.isNone(receiptPath)) {
      throw Error("Missing receipt path");
    }
    const run = await readJson(sourcePath.value);
    const receipt = await readJson(receiptPath.value);
    if (!verifyRollbackReceipt(run, receipt)) throw Error("Untrusted rollback receipt");
    process.stdout.write("Captured release receipt verified.\n");
  } catch {
    process.stderr.write("Manual rollback receipt rejected; Worker traffic unchanged.\n");
    process.exitCode = 1;
  }
}
