import { lstat } from "node:fs/promises";
import { Effect } from "effect";
import { CliFailure } from "../contract";

/** Refuses symlink/non-regular local paths and non-private UNIX permissions before trusted use. */
export const checkLocalPath = Effect.fn(function* (path: string, kind: "file" | "directory") {
  const info = yield* Effect.tryPromise({
    try: () => lstat(path),
    catch: () => new CliFailure({ reason: "StorageUnavailable" }),
  });
  const privatePermissionMask = 0o077;
  const validKind = kind === "file" ? info.isFile() : info.isDirectory();
  if (
    !validKind ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & privatePermissionMask) !== 0)
  ) {
    return yield* new CliFailure({ reason: "StorageInconsistent" });
  }
});
