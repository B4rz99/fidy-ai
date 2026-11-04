import { Effect, Schema, type Scope } from "effect";
import { Miniflare } from "miniflare";
import { makeRemoteSqliteDatabase } from "../sqlite-store/operations";

const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
type Mode = "d1" | "store" | "both" | "missing" | "isolated" | "stale" | "no-recovery";
const modes: ReadonlyArray<Mode> = [
  "d1",
  "store",
  "both",
  "missing",
  "isolated",
  "stale",
  "no-recovery",
];
const hasDatabase = (mode: Mode): boolean => ["d1", "both", "no-recovery"].includes(mode);
const hasStore = (mode: Mode): boolean => ["store", "both", "isolated", "stale"].includes(mode);
const runtime = (contents: string): Miniflare =>
  new Miniflare({
    workers: modes.map((mode) => ({
      config: {
        name: `pro-${mode}`,
        type: "worker",
        compatibilityDate: "2026-09-18",
        compatibilityFlags: ["nodejs_compat"],
        exports: {
          ProStoreProof: { type: "durable-object", storage: "sqlite" },
          RecoveryAdmissionGate: { type: "durable-object", storage: "sqlite" },
        },
        env: {
          ...(hasDatabase(mode) ? { DB: { type: "d1" as const, id: "pro-source" } } : {}),
          ...(hasStore(mode)
            ? {
                SQLITE_STORE: {
                  type: "durable-object" as const,
                  worker: "pro-store",
                  exportName: "ProStoreProof",
                },
                SQLITE_STORE_MANIFEST: { type: "text" as const, value: "fixture" },
                SQLITE_STORE_EPOCH: {
                  type: "text" as const,
                  value: mode === "stale" ? "stale" : "fixture",
                },
              }
            : {}),
          SQLITE_STORE_NAMESPACE_ID: { type: "text", value: "pro-native" },
          ...(mode === "no-recovery"
            ? {}
            : { ERASURE_BUCKET: { type: "r2" as const, name: "pro-registry" } }),
          RECOVERY_SOURCE_EPOCH: { type: "text", value: "pro-source" },
          RECOVERY_ADMISSION: {
            type: "durable-object",
            worker: "pro-d1",
            exportName: "RecoveryAdmissionGate",
          },
          STORE_SETUP: { type: "durable-object", worker: "pro-store", exportName: "ProStoreProof" },
          PRO: { type: "worker", worker: `pro-${mode}`, exportName: "ProGrantService" },
          RECOVERY_ISOLATION: { type: "text", value: mode === "isolated" ? "isolated" : "" },
        },
        manifest: { mainModule: "index.mjs", modules: { "index.mjs": { type: "esm", contents } } },
      },
    })),
  });
export const nativeProOperator: Effect.Effect<
  Readonly<{
    db: D1Database;
    store: D1Database;
    bucket: R2Bucket;
    execute: (mode: Mode, candidate: unknown) => Promise<unknown>;
    gate: () => Promise<unknown>;
    close: () => Promise<unknown>;
    closeStore: () => Promise<unknown>;
  }>,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const built = yield* wait(() =>
    Bun.build({
      entrypoints: [new URL("./worker.test-fixture.ts", import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers", "node:*"],
    })
  );
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return yield* Effect.die(Error("Pro native fixture build failed"));
  }
  const native = runtime(yield* wait(() => output.text()));
  yield* Effect.addFinalizer(() => wait(() => native.dispose()));
  const bindings = yield* wait(() =>
    native.getBindings<{ DB: D1Database; ERASURE_BUCKET: R2Bucket }>("pro-d1")
  );
  const source = yield* wait(() => native.getWorker("pro-d1"));
  const selected = yield* wait(() => native.getWorker("pro-store"));
  return {
    db: bindings.DB,
    bucket: bindings.ERASURE_BUCKET,
    store: makeRemoteSqliteDatabase({
      manifest: "fixture",
      epoch: "fixture",
      store: {
        query: (input) =>
          selected
            .fetch("https://pro/query", { method: "POST", body: encode(input) })
            .then((response) => response.json()),
      },
    }),
    execute: (mode, candidate) =>
      native
        .getWorker(`pro-${mode}`)
        .then((worker) =>
          worker.fetch("https://pro/execute", { method: "POST", body: encode(candidate) })
        )
        .then((response) => response.json()),
    gate: () => source.fetch("https://pro/gate").then((response) => response.json()),
    closeStore: () => selected.fetch("https://pro/store-close").then((response) => response.json()),
    close: () => source.fetch("https://pro/gate-close").then((response) => response.json()),
  };
});
