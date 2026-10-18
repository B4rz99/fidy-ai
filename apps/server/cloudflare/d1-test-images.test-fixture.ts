import { Database } from "bun:sqlite";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem, ManagedRuntime } from "effect";
import type { Miniflare } from "miniflare";

type ImageFiles = Readonly<{
  temporary: () => Promise<string>;
  remove: (path: string) => Promise<void>;
  dispose: () => Promise<void>;
}>;
const imageFiles = (): ImageFiles => {
  const services = ManagedRuntime.make(BunFileSystem.layer);
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
      const pending = original()
        .then(() => serializeNative(file))
        .catch((cause: unknown) => {
          images.delete(key);
          throw cause;
        });
      images.set(key, pending);
      return pending.then(() => undefined);
    },
  };
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
}: Readonly<{
  create: (directory: string) => Miniflare;
  size: number;
}>): Promise<NativeImagePool> => {
  const filesystem = imageFiles();
  return filesystem.temporary().then((directory) => {
    const probe = create(directory);
    return locateNativeFiles({ runtime: probe, directory, size })
      .then((files) =>
        probe.dispose().then(() => {
          const runtime = create(directory);
          return {
            runtime,
            ...imageInstaller(files, filesystem),
            dispose: () => disposeImageRuntime({ runtime, directory, filesystem }),
          };
        })
      )
      .catch((cause: unknown) =>
        probe
          .dispose()
          .then(() => filesystem.remove(directory))
          .then(() => filesystem.dispose())
          .then(() => {
            throw cause;
          })
      );
  });
};
