import { BunServices } from "@effect/platform-bun";
import { IssuedPAT } from "@fidy/server/client";
import { Effect, Exit, FileSystem, Option, Redacted, Schema } from "effect";
import { bunSecrets, makeCredentialStore, supportedBunRevision } from "../src/credential/runtime";
import {
  CliFailure,
  type Credential,
  type NativeSecrets,
  apiOrigin,
} from "../src/credential/contract";
import { scopedProcess } from "./process.test-fixture";

const probe = Redacted.make("fidy-native-cross-process-probe");
const failed = (): CliFailure => new CliFailure({ reason: "StorageUnavailable" });
const readProbe = Effect.fn(function* (name: string) {
  const value = yield* bunSecrets.get(name);
  if (Option.isNone(value) || Redacted.value(value.value) !== Redacted.value(probe)) {
    return yield* failed();
  }
});
const child = Effect.fn(
  function* (command: ReadonlyArray<string>) {
    const owned = yield* scopedProcess(command);
    if ((yield* owned.exited) !== 0) {
      return yield* failed();
    }
  },
  Effect.scoped,
  Effect.mapError(failed)
);
const secretCharacterCount = 43;
const credential: Credential = {
  grant: {
    origin: apiOrigin,
    pat: Schema.decodeSync(Schema.toCodecJson(IssuedPAT.fields.pat))({
      _tag: "PAT",
      id: "01900000-0000-4000-8000-000000000001",
      shortId: "abcd1234",
      recipientLabel: "Native conformance",
      scopes: ["read"],
      lifetimeDays: 7,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-08T00:00:00.000Z",
    }),
  },
  bearer: Redacted.make(`fin_abcd1234_${"s".repeat(secretCharacterCount)}`),
};
const isolatedSecrets = (prefix: string): NativeSecrets => ({
  get: (name) => bunSecrets.get(`${prefix}-${name}`),
  set: (name, value) => bunSecrets.set(`${prefix}-${name}`, value),
  delete: (name) => bunSecrets.delete(`${prefix}-${name}`),
});
const competingSave = Effect.fn(function* (directory: string, prefix: string, expected: string) {
  const { store } = yield* makeCredentialStore(directory, isolatedSecrets(prefix));
  const result = yield* store.save(credential).pipe(Effect.result);
  if (result._tag !== "Failure" || result.failure.reason !== expected) return yield* failed();
});
const verifySaveRace = Effect.fn(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  const native = isolatedSecrets(prefix);
  const contender = (expected: string): Effect.Effect<void, CliFailure> =>
    child([process.execPath, import.meta.filename, "compete", directory, prefix, expected]);
  const { store } = yield* makeCredentialStore(directory, {
    ...native,
    set: (name, value) =>
      native.set(name, value).pipe(Effect.andThen(contender("StorageUnavailable"))),
  });
  yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.gen(function* () {
        yield* store.save(credential);
        yield* contender("AlreadyLoggedIn");
        const loaded = yield* store.load;
        if (Option.isNone(loaded) || loaded.value.grant.pat.shortId !== "abcd1234") {
          return yield* failed();
        }
      }),
    () => native.delete("login")
  );
}, Effect.scoped);
const program = Effect.gen(function* () {
  if (Bun.revision !== supportedBunRevision) return yield* failed();
  if (Bun.argv[2] === "compete") {
    const [directory, prefix, expected] = Bun.argv.slice(3);
    if (directory === undefined || prefix === undefined || expected === undefined) {
      return yield* failed();
    }
    return yield* competingSave(directory, prefix, expected);
  }
  const name = Bun.argv[3];
  if (Bun.argv[2] === "read" && name !== undefined) return yield* readProbe(name);
  const probeName = `native-conformance-${process.pid}-${Bun.nanoseconds()}`;
  yield* verifySaveRace(probeName);
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
const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(BunServices.layer)));
if (Exit.isFailure(exit)) {
  process.stderr.write("Native-store conformance unavailable or failed; no plaintext fallback.\n");
  process.exitCode = 1;
} else if (Bun.argv[2] === undefined) {
  process.stdout.write("Native-store cross-process persistence passed.\n");
}
