import { Data, Effect, FileSystem, type Scope } from "effect";
import { Miniflare } from "miniflare";

class FixtureFailure extends Data.TaggedError("FixtureFailure") {}
const fromPromise = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: () => Promise.resolve(run()), catch: () => new FixtureFailure() }).pipe(
    Effect.orDie
  );

type StorageBindings = Readonly<{ db: D1Database; bucket: R2Bucket }>;
type PersistentStorage = Readonly<{
  acquire: () => Promise<StorageBindings>;
  restart: () => Promise<StorageBindings>;
}>;

/** Local D1/R2 with unchanged binding identities across a complete workerd restart. */
export const persistentStagingStorage: Effect.Effect<
  PersistentStorage,
  never,
  FileSystem.FileSystem | Scope.Scope
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const persistencePath = yield* fs
    .makeTempDirectory({ prefix: "fidy-staging-race-" })
    .pipe(Effect.orDie);
  const create = (): Miniflare =>
    new Miniflare({
      resourcePersistencePath: persistencePath,
      workers: [
        {
          config: {
            name: "statement-upload-race",
            type: "worker",
            compatibilityDate: "2026-09-08",
            env: {
              DB: { type: "d1", id: "statement-upload-race" },
              BUCKET: { type: "r2", name: "statement-upload-race" },
            },
            manifest: {
              mainModule: "index.mjs",
              modules: {
                "index.mjs": {
                  type: "esm",
                  contents: "export default { fetch() { return new Response('local fixture') } }",
                },
              },
            },
          },
        },
      ],
    });
  let runtime = create();
  yield* Effect.addFinalizer(() =>
    fromPromise(() => runtime.dispose()).pipe(
      Effect.ensuring(
        fs.remove(persistencePath, { force: true, recursive: true }).pipe(Effect.orDie)
      )
    )
  );
  const acquire = (): Promise<StorageBindings> =>
    Promise.all([runtime.getD1Database("DB"), runtime.getBindings<{ BUCKET: R2Bucket }>()]).then(
      ([db, bindings]) => ({ db, bucket: bindings.BUCKET })
    );
  return {
    acquire,
    restart: (): Promise<StorageBindings> =>
      runtime.dispose().then(() => {
        runtime = create();
        return acquire();
      }),
  };
});

/**
 * Injects delayed dispatch or a rejected acknowledgement followed by a remote write. The bytes
 * and deletes use real local R2, but this ordering is synthetic, not a production R2 fault.
 */
export const delayedUpload = (
  input: Readonly<{ bucket: R2Bucket; outcome: "success" | "ambiguous-rejection" }>
): Readonly<{
  bucket: R2Bucket;
  entered: Promise<void>;
  release: () => void;
  rejectAcknowledgement: () => void;
  settled: Promise<void>;
}> => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const acknowledgement = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const wrapped = new Proxy(input.bucket, {
    get: (target, property): unknown =>
      property === "put"
        ? (...args: Parameters<R2Bucket["put"]>): ReturnType<R2Bucket["put"]> => {
            const write = release.promise.then(() => target.put(...args));
            write.then(() => settled.resolve(), settled.reject);
            entered.resolve();
            return input.outcome === "success"
              ? write
              : acknowledgement.promise.then(() => {
                  throw new Error("synthetic ambiguous acknowledgement");
                });
          }
        : Reflect.get(target, property, target),
  });
  return {
    bucket: wrapped,
    entered: entered.promise,
    release: (): void => release.resolve(),
    rejectAcknowledgement: (): void => acknowledgement.resolve(),
    settled: settled.promise,
  };
};
