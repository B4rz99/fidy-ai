import { IssuedPAT } from "@fidy/server/client";
import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, PlatformError, Redacted, Schema } from "effect";
import { CliFailure, type Credential, type NativeSecrets, apiOrigin } from "./contract";
import { makeCredentialStore } from "./runtime";

const secretLength = 43;
const bearer = `fin_abcd1234_${"s".repeat(secretLength)}`;
const issued = Schema.decodeSync(Schema.toCodecJson(IssuedPAT))({
  bearer,
  pat: {
    _tag: "PAT",
    id: "01900000-0000-4000-8000-000000000001",
    shortId: "abcd1234",
    recipientLabel: "Mi agente",
    scopes: ["read"],
    lifetimeDays: 7,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-08T00:00:00.000Z",
  },
});
const credential: Credential = {
  grant: { origin: apiOrigin, pat: issued.pat },
  bearer: issued.bearer,
};
const nativeFixture = (): Readonly<{
  native: NativeSecrets;
  values: Map<string, string>;
  calls: Array<string>;
}> => {
  const values = new Map<string, string>();
  const calls: Array<string> = [];
  return {
    values,
    calls,
    native: {
      get: (name) =>
        Effect.sync(() => {
          calls.push(`get:${name}`);
          return Option.map(Option.fromUndefinedOr(values.get(name)), Redacted.make);
        }),
      set: (name, value) =>
        Effect.sync(() => {
          calls.push(`set:${name}`);
          values.set(name, Redacted.value(value));
        }),
      delete: (name) =>
        Effect.sync(() => {
          calls.push(`delete:${name}`);
          values.delete(name);
        }),
    },
  };
};

layer(BunServices.layer)((it) => {
  const unsafePaths = ["linked directory", "linked metadata", "nonregular metadata"] as const;
  for (const unsafePath of unsafePaths) {
    it.effect(
      `refuses ${unsafePath} before accessing native credentials or changing link targets`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();
          const directory = `${root}/credentials`;
          const target = `${root}/target`;
          yield* fs.makeDirectory(target, { mode: 0o700 });
          yield* fs.writeFileString(`${target}/sentinel`, "untouched", { mode: 0o600 });
          if (unsafePath === "linked directory") {
            yield* fs.symlink(target, directory);
          } else {
            yield* fs.makeDirectory(directory, { mode: 0o700 });
            if (unsafePath === "linked metadata") {
              yield* fs.symlink(`${target}/sentinel`, `${directory}/grant.json`);
            } else {
              yield* fs.makeDirectory(`${directory}/grant.json`, { mode: 0o700 });
            }
          }
          const fixture = nativeFixture();
          fixture.values.set("login", bearer);
          const { store } = yield* makeCredentialStore(directory, fixture.native);
          expect(Exit.isFailure(yield* Effect.exit(store.load))).toBe(true);
          expect(Exit.isFailure(yield* Effect.exit(store.save(credential)))).toBe(true);
          expect(fixture.calls).toEqual([]);
          expect(fixture.values.get("login") === bearer).toBe(true);
          expect(yield* fs.readFileString(`${target}/sentinel`)).toBe("untouched");
          expect(yield* fs.exists(`${directory}/login.lock`)).toBe(false);
          expect(yield* fs.readDirectory(target)).toEqual(["sentinel"]);
        }).pipe(Effect.scoped)
    );
  }

  if (process.platform !== "win32") {
    for (const unsafePath of ["directory", "metadata"] as const) {
      it.effect(
        `refuses nonprivate UNIX ${unsafePath} without releasing or replacing credentials`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const directory = yield* fs.makeTempDirectoryScoped();
            const fixture = nativeFixture();
            const { store } = yield* makeCredentialStore(directory, fixture.native);
            yield* store.save(credential);
            const metadata = yield* fs.readFileString(`${directory}/grant.json`);
            fixture.calls.length = 0;
            yield* fs.chmod(
              unsafePath === "directory" ? directory : `${directory}/grant.json`,
              0o755
            );
            expect(Exit.isFailure(yield* Effect.exit(store.load))).toBe(true);
            expect(Exit.isFailure(yield* Effect.exit(store.save(credential)))).toBe(true);
            expect(fixture.calls).toEqual([]);
            expect(fixture.values.get("login") === bearer).toBe(true);
            expect(yield* fs.readFileString(`${directory}/grant.json`)).toBe(metadata);
            expect(yield* fs.exists(`${directory}/login.lock`)).toBe(false);
          }).pipe(Effect.scoped)
      );
    }
  }

  it.effect(
    "stores only metadata in the file and reuses the bearer in a newly constructed store",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const fixture = nativeFixture();
        const first = yield* makeCredentialStore(directory, fixture.native);
        yield* first.verifyStorage;
        yield* first.store.save(credential);
        const file = yield* fs.readFileString(`${directory}/grant.json`);
        expect(file).not.toContain(bearer);
        expect(fixture.values.get("login")).toBe(bearer);
        const second = yield* makeCredentialStore(directory, fixture.native);
        const loaded = yield* second.store.load;
        expect(Option.isSome(loaded)).toBe(true);
        yield* second.store.clear;
        expect(yield* first.store.load).toEqual(Option.none());
      }).pipe(Effect.scoped)
  );

  it.effect(
    "refuses substituted origins and mismatched metadata without releasing a credential",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const fixture = nativeFixture();
        const store = yield* makeCredentialStore(directory, fixture.native);
        yield* store.store.save(credential);
        const text = yield* fs.readFileString(`${directory}/grant.json`);
        yield* fs.writeFileString(
          `${directory}/grant.json`,
          text.replace(apiOrigin, "https://attacker.example")
        );
        expect(Exit.isFailure(yield* Effect.exit(store.store.load))).toBe(true);
        expect(fixture.values.get("login")).toBe(bearer);
        yield* store.store.clear;
        yield* fixture.native.set("login", Redacted.make(bearer));
        expect(Exit.isFailure(yield* Effect.exit(store.store.load))).toBe(true);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "never treats a partial save as a usable login and permits explicit local cleanup",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const fixture = nativeFixture();
        const broken: NativeSecrets = {
          ...fixture.native,
          set: (name, value) =>
            fixture.native
              .set(name, value)
              .pipe(Effect.andThen(Effect.fail(new CliFailure({ reason: "StorageUnavailable" })))),
        };
        const store = yield* makeCredentialStore(directory, broken);
        expect(Exit.isFailure(yield* Effect.exit(store.store.save(credential)))).toBe(true);
        expect(yield* fs.exists(`${directory}/grant.json`)).toBe(false);
        expect(Exit.isFailure(yield* Effect.exit(store.store.load))).toBe(true);
        yield* store.store.clear;
        expect(yield* store.store.load).toEqual(Option.none());
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a metadata write failure after native save stays inconsistent and never overwrites a saved login",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const fixture = nativeFixture();
        const unavailable = new PlatformError.PlatformError(
          new PlatformError.SystemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "open",
          })
        );
        const failingFs: FileSystem.FileSystem = {
          ...fs,
          open: (path, options) =>
            options?.flag === "wx" ? Effect.fail(unavailable) : fs.open(path, options),
        };
        const first = yield* makeCredentialStore(directory, fixture.native).pipe(
          Effect.provideService(FileSystem.FileSystem, failingFs)
        );
        expect(Exit.isFailure(yield* Effect.exit(first.store.save(credential)))).toBe(true);
        expect(fixture.values.get("login") === bearer).toBe(true);
        expect(yield* fs.exists(`${directory}/grant.json`)).toBe(false);
        expect(Exit.isFailure(yield* Effect.exit(first.store.load))).toBe(true);
        yield* first.store.clear;
        const normal = yield* makeCredentialStore(directory, fixture.native);
        yield* normal.store.save(credential);
        expect(Exit.isFailure(yield* Effect.exit(normal.store.save(credential)))).toBe(true);
        expect(fixture.values.get("login") === bearer).toBe(true);
      }).pipe(Effect.scoped)
  );
});
