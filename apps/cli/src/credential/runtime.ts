import { TokenBearer, getTokenShortId } from "@fidy/server/client";
import {
  ByteSize,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";
import {
  CliFailure,
  type Credential,
  type CredentialStore,
  type NativeSecrets,
  SavedGrant,
} from "./contract";
import { checkLocalPath } from "./internal/local-path";

export const supportedBunRevision = "a7733435cf40429e3b35c36072769df2052b80f1";

const nativeService = "com.fidy.cli.api.fidyapp.com";

const savedName = "login";

const probeName = "storage-probe";

const maximumMetadataBytes = 16_384;

const maximumBearerCharacters = 4096;

const privateDirectoryMode = 0o700;

const privateFileMode = 0o600;

const storageUnavailable = (): CliFailure =>
  new CliFailure({ reason: "StorageUnavailable", cause: Option.none() });

const inconsistent = (): CliFailure =>
  new CliFailure({ reason: "StorageInconsistent", cause: Option.none() });

const grantCodec = Schema.fromJsonString(Schema.toCodecJson(SavedGrant));

const boundedBearer = TokenBearer.check(Schema.isMaxLength(maximumBearerCharacters));

const guardRuntime = <A>(work: Effect.Effect<A, CliFailure>): Effect.Effect<A, CliFailure> =>
  Effect.suspend(() =>
    Bun.revision === supportedBunRevision
      ? work
      : Effect.fail(new CliFailure({ reason: "UnsupportedRuntime", cause: Option.none() }))
  );

export const bunSecrets: NativeSecrets = {
  get: (name) =>
    guardRuntime(
      Effect.tryPromise({
        try: () => Bun.secrets.get({ service: nativeService, name }),
        catch: storageUnavailable,
      }).pipe(Effect.map((value) => Option.map(Option.fromNullOr(value), Redacted.make)))
    ),
  set: (name, value) => {
    const options = {
      service: nativeService,
      name,
      value: Redacted.value(value),
      persist: "local",
    } as const;

    return guardRuntime(
      Effect.tryPromise({ try: () => Bun.secrets.set(options), catch: storageUnavailable })
    );
  },
  delete: (name) =>
    guardRuntime(
      Effect.tryPromise({
        try: () => Bun.secrets.delete({ service: nativeService, name }),
        catch: storageUnavailable,
      }).pipe(Effect.asVoid)
    ),
};

const readGrant = Effect.fn(function* (filesystem: FileSystem.FileSystem, metadataPath: string) {
  if (!(yield* filesystem.exists(metadataPath).pipe(Effect.mapError(storageUnavailable)))) {
    return Option.none<SavedGrant>();
  }

  yield* checkLocalPath(metadataPath, "file");
  const file = yield* filesystem.open(metadataPath).pipe(Effect.mapError(storageUnavailable));
  const info = yield* file.stat.pipe(Effect.mapError(storageUnavailable));

  if (info.type !== "File" || ByteSize.toBigInt(info.size) > BigInt(maximumMetadataBytes)) {
    return yield* inconsistent();
  }

  const bytes = yield* file
    .readAlloc(maximumMetadataBytes + 1)
    .pipe(Effect.mapError(storageUnavailable));

  if (
    Option.isNone(bytes) ||
    bytes.value.byteLength > maximumMetadataBytes ||
    BigInt(bytes.value.byteLength) !== ByteSize.toBigInt(info.size)
  ) {
    return yield* inconsistent();
  }

  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.value),
    catch: inconsistent,
  });

  const grant = yield* Schema.decodeEffect(grantCodec, { onExcessProperty: "error" })(text).pipe(
    Effect.mapError(inconsistent)
  );

  return Option.some(grant);
}, Effect.scoped);

const loadCredential = Effect.fn(function* (
  metadata: Effect.Effect<Option.Option<SavedGrant>, CliFailure>,
  secrets: NativeSecrets
) {
  const grant = yield* metadata;
  const secret = yield* secrets.get(savedName);

  if (Option.isNone(grant) && Option.isNone(secret)) return Option.none<Credential>();

  if (Option.isNone(grant) || Option.isNone(secret)) return yield* inconsistent();

  const bearer = yield* Schema.decodeEffect(boundedBearer)(Redacted.value(secret.value)).pipe(
    Effect.mapError(inconsistent)
  );

  if ((yield* getTokenShortId(bearer)) !== grant.value.pat.shortId) return yield* inconsistent();

  return Option.some({ grant: grant.value, bearer: Redacted.make(bearer) });
});

const verifyNativeStore = (
  options: Readonly<{
    filesystem: FileSystem.FileSystem;
    secrets: NativeSecrets;
    probePath: string;
  }>
): Effect.Effect<void, CliFailure> => {
  const probe = Redacted.make("fidy-storage-usability-probe");

  return Effect.acquireUseRelease(
    options.secrets.set(probeName, probe),
    () =>
      Effect.gen(function* () {
        const found = yield* options.secrets.get(probeName);

        if (Option.isNone(found) || Redacted.value(found.value) !== Redacted.value(probe)) {
          return yield* storageUnavailable();
        }

        yield* options.filesystem
          .writeFileString(options.probePath, "storage-probe", {
            flag: "wx",
            mode: privateFileMode,
          })
          .pipe(Effect.mapError(storageUnavailable));
      }),
    () => options.secrets.delete(probeName)
  );
};

const writeGrant = Effect.fn(function* (
  filesystem: FileSystem.FileSystem,
  metadataPath: string,
  text: string
) {
  const write = Effect.gen(function* () {
    const file = yield* filesystem.open(metadataPath, { flag: "wx", mode: privateFileMode });
    yield* file.writeAll(new TextEncoder().encode(text));
    yield* file.sync;
  });

  yield* write.pipe(Effect.scoped, Effect.mapError(storageUnavailable));
});

export const openCredentialStore = Effect.fn(function* (
  directory: string,
  secrets: NativeSecrets = bunSecrets
) {
  const filesystem = yield* FileSystem.FileSystem;
  const metadataPath = `${directory}/grant.json`;
  const lockPath = `${directory}/login.lock`;

  const withLock = <A>(work: Effect.Effect<A, CliFailure>): Effect.Effect<A, CliFailure> =>
    Effect.acquireUseRelease(
      filesystem
        .makeDirectory(directory, { recursive: true, mode: privateDirectoryMode })
        .pipe(
          Effect.andThen(checkLocalPath(directory, "directory")),
          Effect.andThen(filesystem.makeDirectory(lockPath, { mode: privateDirectoryMode })),
          Effect.mapError(storageUnavailable)
        ),
      () => work,
      () =>
        filesystem.remove(lockPath, { recursive: true }).pipe(Effect.mapError(storageUnavailable))
    );

  const load = loadCredential(readGrant(filesystem, metadataPath), secrets);

  const store: CredentialStore = {
    load: withLock(load).pipe(Effect.uninterruptible),
    save: (credential) =>
      withLock(
        Effect.gen(function* () {
          if (Option.isSome(yield* load)) {
            return yield* new CliFailure({ reason: "AlreadyLoggedIn", cause: Option.none() });
          }

          const text = yield* Schema.encodeEffect(grantCodec)(credential.grant).pipe(
            Effect.mapError(inconsistent)
          );

          yield* secrets.set(savedName, credential.bearer);
          yield* writeGrant(filesystem, metadataPath, text);
          const persisted = yield* load;

          if (
            Option.isNone(persisted) ||
            Redacted.value(persisted.value.bearer) !== Redacted.value(credential.bearer)
          ) {
            return yield* inconsistent();
          }
        })
      ).pipe(Effect.uninterruptible),
    clear: withLock(
      secrets
        .delete(savedName)
        .pipe(
          Effect.andThen(
            filesystem
              .remove(metadataPath, { force: true })
              .pipe(Effect.mapError(storageUnavailable))
          )
        )
    ).pipe(Effect.uninterruptible),
  };

  const verifyStorage = withLock(
    verifyNativeStore({ filesystem, secrets, probePath: `${lockPath}/probe` })
  ).pipe(Effect.uninterruptible);

  return { store, verifyStorage };
});

export class CredentialStorage extends Context.Service<
  CredentialStorage,
  Readonly<{ store: CredentialStore; verifyStorage: Effect.Effect<void, CliFailure> }>
>()("@fidy/cli/credential/runtime/CredentialStorage") {
  static readonly make = Effect.gen(function* () {
    const home = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
      process.platform === "win32" ? Bun.env.USERPROFILE : Bun.env.HOME
    ).pipe(
      Effect.mapError(
        (cause) => new CliFailure({ reason: "StorageUnavailable", cause: Option.some(cause) })
      )
    );

    const path = yield* Path.Path;

    if (!path.isAbsolute(home)) {
      return yield* new CliFailure({ reason: "StorageUnavailable", cause: Option.none() });
    }

    return yield* openCredentialStore(path.join(home, ".fidy", "cli"));
  });

  static readonly layer = Layer.effect(this, this.make);
}
