import { Database } from "bun:sqlite";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem, ManagedRuntime, Option, Schema } from "effect";
import type { Miniflare } from "miniflare";

type ImageFiles = Readonly<{
  temporary: () => Promise<string>;
  remove: (path: string) => Promise<void>;
  readArtifact: (key: string) => Promise<Option.Option<Uint8Array>>;
  writeArtifact: (key: string, bytes: Uint8Array) => Promise<void>;
  dispose: () => Promise<void>;
}>;
const imageFiles = (): ImageFiles => {
  const services = ManagedRuntime.make(BunFileSystem.layer);
  const cache = Option.fromUndefinedOr(Bun.env.NATIVE_TEST_IMAGE_CACHE);
  return {
    temporary: () =>
      services.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.makeTempDirectory({ prefix: "fidy-native-images-" })
        )
      ),
    remove: (path) =>
      services.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.remove(path, { recursive: true, force: true })
        )
      ),
    readArtifact: (key) =>
      Option.isNone(cache)
        ? Promise.resolve(Option.none())
        : services.runPromise(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = `${cache.value}/${key}`;
              return (yield* fs.exists(path))
                ? Option.some(yield* fs.readFile(path))
                : Option.none();
            })
          ),
    writeArtifact: (key, bytes) =>
      Option.isNone(cache)
        ? Promise.resolve()
        : services.runPromise(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              yield* fs.makeDirectory(cache.value, { recursive: true });
              const staging = yield* fs.makeTempDirectoryScoped({ directory: cache.value });
              yield* fs.writeFile(`${staging}/artifact`, bytes);
              // Publish complete bytes atomically; concurrent builders may produce the same image.
              yield* fs.rename(`${staging}/artifact`, `${cache.value}/${key}`);
            }).pipe(Effect.scoped)
          ),
    dispose: () => services.dispose(),
  };
};

export type NativeImagePool = Readonly<{
  runtime: Miniflare;
  used: (index: number) => void;
  install: (
    input: Readonly<{ index: number; sql: ReadonlyArray<string>; original: () => Promise<void> }>
  ) => Promise<void>;
  dispose: () => Promise<void>;
}>;
const databaseFiles = (directory: string): ReadonlyArray<string> =>
  Array.from(new Bun.Glob("d1/**/*.sqlite").scanSync({ cwd: directory, absolute: true })).filter(
    (file) => /\/[0-9a-f]{64}\.sqlite$/u.test(file)
  );
const serializeNative = (file: string): Uint8Array => {
  // Read the native image, including committed WAL pages; never execute application SQL in Bun.
  const database = new Database(file, { readonly: true });
  try {
    const image = database.serialize();
    // SQLite documents this conversion for standalone serialized WAL images:
    // https://www.sqlite.org/c3ref/deserialize.html
    image[18] = 1;
    image[19] = 1;
    return image;
  } finally {
    database.close();
  }
};
const restoreNative = (file: string, image: Uint8Array, filesystem: ImageFiles): Promise<void> =>
  Promise.all([filesystem.remove(`${file}-wal`), filesystem.remove(`${file}-shm`)])
    .then(() => Bun.write(file, image))
    .then(() => undefined);

const locateNativeFiles = ({
  runtime,
  directory,
  size,
}: Readonly<{
  runtime: Miniflare;
  directory: string;
  size: number;
}>): Promise<ReadonlyArray<string>> => {
  const files: string[] = [];
  return Array.from({ length: size }, (_, index) => index)
    .reduce<Promise<void>>(
      (previous, index) =>
        previous
          .then(() =>
            runtime.dispatchFetch(`http://fixture/DB_${index}/query`, {
              method: "POST",
              body: JSON.stringify({
                operation: "first",
                statements: [{ sql: "SELECT 1", params: [] }],
              }),
            })
          )
          .then((response) => response.json())
          .then(() => {
            const added = databaseFiles(directory).filter((file) => !files.includes(file));
            if (added.length !== 1 || added[0] === undefined) {
              throw new Error("Native D1 image layout changed");
            }
            files.push(added[0]);
          }),
      Promise.resolve()
    )
    .then(() => files);
};

const imageInstaller = (
  files: ReadonlyArray<string>,
  filesystem: ImageFiles
): Pick<NativeImagePool, "used" | "install"> => {
  const used = new Set<number>();
  const images = new Map<string, Promise<Uint8Array>>();
  return {
    used: (index) => {
      used.add(index);
    },
    install: ({ index, sql, original }) => {
      // An already opened binding may contain caller-owned schema or rows. Never replace it.
      if (used.has(index)) return original();
      const file = files[index];
      if (file === undefined) return Promise.reject(new Error("Missing native D1 image slot"));
      const key = sql.join("\u0000");
      const image = images.get(key);
      used.add(index);
      if (image !== undefined) return image.then((bytes) => restoreNative(file, bytes, filesystem));
      // Capture before install resolves to its caller, so no test mutation enters this cache.
      const artifact = `schema-${new Bun.CryptoHasher("sha256").update(key).digest("hex")}.sqlite`;
      const pending = filesystem
        .readArtifact(artifact)
        .then((cached) => {
          if (Option.isSome(cached)) {
            return restoreNative(file, cached.value, filesystem).then(() => cached.value);
          }
          return original()
            .then(() => serializeNative(file))
            .then((bytes) => filesystem.writeArtifact(artifact, bytes).then(() => bytes));
        })
        .catch((cause: unknown) => {
          images.delete(key);
          throw cause;
        });
      images.set(key, pending);
      return pending.then(() => undefined);
    },
  };
};

const closeDiscovery = (
  work: Promise<ReadonlyArray<string>>,
  probe: Miniflare
): Promise<ReadonlyArray<string>> =>
  work.then(
    (files) => probe.dispose().then(() => files),
    (cause: unknown) =>
      probe.dispose().then(() => {
        throw cause;
      })
  );

const cachedNativeFiles = ({
  create,
  directory,
  size,
  layoutKey,
  filesystem,
}: Readonly<{
  create: (directory: string) => Miniflare;
  directory: string;
  size: number;
  layoutKey: string;
  filesystem: ImageFiles;
}>): Promise<ReadonlyArray<string>> => {
  const artifact = `layout-${new Bun.CryptoHasher("sha256").update(`${layoutKey}:${size}`).digest("hex")}.json`;
  return filesystem.readArtifact(artifact).then((cached) => {
    if (Option.isSome(cached)) {
      const paths = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
        new TextDecoder().decode(cached.value)
      );
      if (
        paths.length !== size ||
        new Set(paths).size !== size ||
        paths.some((path) => !/^d1\/miniflare-D1DatabaseObject\/[0-9a-f]{64}\.sqlite$/u.test(path))
      ) {
        throw new Error("Invalid run-scoped native D1 layout");
      }
      return paths.map((path) => `${directory}/${path}`);
    }
    const probe = create(directory);
    return closeDiscovery(
      locateNativeFiles({ runtime: probe, directory, size }).then((files) =>
        filesystem
          .writeArtifact(
            artifact,
            new TextEncoder().encode(
              JSON.stringify(files.map((file) => file.slice(directory.length + 1)))
            )
          )
          .then(() => files)
      ),
      probe
    );
  });
};

const disposeImageRuntime = ({
  runtime,
  directory,
  filesystem,
}: Readonly<{ runtime: Miniflare; directory: string; filesystem: ImageFiles }>): Promise<void> =>
  runtime
    .dispose()
    .then(() => filesystem.remove(directory))
    .then(() => filesystem.dispose());

/** Discover empty native slots, close every connection, then clone only into unopened bindings. */
export const nativeImagePool = ({
  create,
  size,
  layoutKey,
}: Readonly<{
  create: (directory: string) => Miniflare;
  size: number;
  layoutKey: string;
}>): Promise<NativeImagePool> => {
  const filesystem = imageFiles();
  return filesystem.temporary().then((directory) => {
    return cachedNativeFiles({ create, directory, size, layoutKey, filesystem })
      .then((files) => {
        const runtime = create(directory);
        return {
          runtime,
          ...imageInstaller(files, filesystem),
          dispose: () => disposeImageRuntime({ runtime, directory, filesystem }),
        };
      })
      .catch((cause: unknown) =>
        filesystem
          .remove(directory)
          .then(() => filesystem.dispose())
          .then(() => {
            throw cause;
          })
      );
  });
};
