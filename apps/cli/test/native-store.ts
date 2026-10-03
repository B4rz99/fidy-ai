import { Effect, Exit, Option, Redacted } from "effect";
import { bunSecrets, supportedBunRevision } from "../src/credential/runtime";
import { CliFailure } from "../src/credential/contract";

const probe = Redacted.make("fidy-native-cross-process-probe");
const failed = (): CliFailure => new CliFailure({ reason: "StorageUnavailable" });
const readProbe = Effect.fn(function* (name: string) {
  const value = yield* bunSecrets.get(name);
  if (Option.isNone(value) || Redacted.value(value.value) !== Redacted.value(probe)) {
    return yield* failed();
  }
});
const child = (command: ReadonlyArray<string>): Effect.Effect<void, CliFailure> =>
  Effect.tryPromise({
    try: () =>
      Bun.spawn([...command], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited,
    catch: failed,
  }).pipe(Effect.flatMap((code) => (code === 0 ? Effect.void : Effect.fail(failed()))));
const program = Effect.gen(function* () {
  if (Bun.revision !== supportedBunRevision) return yield* failed();
  const name = Bun.argv[3];
  if (Bun.argv[2] === "read" && name !== undefined) return yield* readProbe(name);
  const probeName = `native-conformance-${process.pid}-${Bun.nanoseconds()}`;
  yield* Effect.acquireUseRelease(
    bunSecrets.set(probeName, probe),
    () =>
      Effect.gen(function* () {
        yield* child([process.execPath, import.meta.filename, "read", probeName]);
        if (process.platform === "win32") {
          yield* child([
            "powershell.exe",
            "-NoProfile",
            "-File",
            Bun.fileURLToPath(new URL("./windows-persistence.ps1", import.meta.url)),
            "-Name",
            probeName,
          ]);
        }
      }),
    () => bunSecrets.delete(probeName)
  );
});
const exit = await Effect.runPromiseExit(program);
if (Exit.isFailure(exit)) {
  process.stderr.write("Native-store conformance unavailable or failed; no plaintext fallback.\n");
  process.exitCode = 1;
} else if (Bun.argv[2] !== "read") {
  process.stdout.write("Native-store cross-process persistence passed.\n");
}
