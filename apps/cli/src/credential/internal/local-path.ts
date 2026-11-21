import { lstat } from "node:fs/promises";
import { Effect, Option } from "effect";
import { CliFailure } from "../contract";

export const checkLocalPath = Effect.fn(function* (path: string, kind: "file" | "directory") {
  const info = yield* Effect.tryPromise({
    try: () => lstat(path),
    catch: () => new CliFailure({ reason: "StorageUnavailable", cause: Option.none() }),
  });

  const privatePermissionMask = 0o077;
  const validKind = kind === "file" ? info.isFile() : info.isDirectory();

  if (
    !validKind ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & privatePermissionMask) !== 0)
  ) {
    return yield* new CliFailure({ reason: "StorageInconsistent", cause: Option.none() });
  }
});
