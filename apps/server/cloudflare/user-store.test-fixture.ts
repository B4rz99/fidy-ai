import { Effect, FileSystem, type Scope } from "effect";
import { Miniflare } from "miniflare";
import { browserOrigins } from "./runtime/contract";

export const native = <Value>(run: () => Promise<Value>): Effect.Effect<Value> =>
  Effect.tryPromise(run).pipe(Effect.orDie);

const manifest = Effect.fn(function* (module: string) {
  const result = yield* native(() =>
    Bun.build({
      entrypoints: [new URL(module, import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers", "node:*"],
    })
  );
  const output = result.outputs[0];
  if (!result.success || output === undefined) {
    return yield* Effect.die(new Error("Native Worker build failed"));
  }
  const contents = yield* native(() => output.text());
  return { mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents } } };
});

/** Production ingress and Core in separate workerd isolates. SQL inspection belongs to the host fixture only. */
export const nativeUserPlatform = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-user-store-" });
  const [ingress, core] = yield* Effect.all(
    [manifest("./public-worker.ts"), manifest("./core-worker.ts")],
    { concurrency: 2 }
  );
  const origin = { type: "text", value: browserOrigins.production } as const;
  const create = (): Miniflare =>
    new Miniflare({
      unsafeInspectDurableObjects: true,
      resourcePersistencePath: directory,
      workers: [
        {
          config: {
            type: "worker",
            name: "ingress",
            compatibilityDate: "2026-09-08",
            compatibilityFlags: ["nodejs_compat"],
            manifest: ingress,
            env: { BROWSER_ORIGIN: origin, CORE: { type: "worker", worker: "core" } },
          },
        },
        {
          config: {
            type: "worker",
            name: "core",
            compatibilityDate: "2026-09-08",
            compatibilityFlags: ["nodejs_compat"],
            manifest: core,
            exports: {
              UserStore: { type: "durable-object", storage: "sqlite" },
              Directory: { type: "durable-object", storage: "sqlite" },
            },
            env: {
              BROWSER_ORIGIN: origin,
              CF_VERSION_METADATA: { type: "version-metadata" },
              USER_STORE: { type: "durable-object", worker: "core", exportName: "UserStore" },
              DIRECTORY: { type: "durable-object", worker: "core", exportName: "Directory" },
            },
          },
        },
      ],
    });
  return (): Effect.Effect<Miniflare, never, Scope.Scope> =>
    Effect.acquireRelease(Effect.sync(create), (runtime) => native(() => runtime.dispose()));
});
