import { Effect, Schema, type Scope } from "effect";
import { Miniflare } from "miniflare";
import type { RecoveryClosedSourceEvidence } from "../recovery-activation/contract";

const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const runtime = (contents: string): Miniflare =>
  new Miniflare({
    workers: [
      {
        config: {
          name: "sqlite-import",
          type: "worker",
          compatibilityDate: "2026-09-18",
          exports: {
            ImportStoreProof: { type: "durable-object", storage: "sqlite" },
            BootstrapRefusalProof: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            DB: { type: "d1", id: "closed-source" },
            ARTIFACTS: { type: "r2", name: "private-artifacts" },
            SQLITE_STORE_MANIFEST: { type: "text", value: "import-native" },
            SQLITE_STORE_EPOCH: { type: "text", value: "next-epoch" },
            SQLITE_STORE_NAMESPACE_ID: { type: "text", value: "native-import" },
            REFUSAL_STORE: {
              type: "durable-object",
              worker: "sqlite-import",
              exportName: "BootstrapRefusalProof",
            },
            STORE: {
              type: "durable-object",
              worker: "sqlite-import",
              exportName: "ImportStoreProof",
            },
          },
          manifest: {
            mainModule: "index.mjs",
            modules: { "index.mjs": { type: "esm", contents } },
          },
        },
      },
    ],
  });
export const nativeSqliteImport: Effect.Effect<
  Readonly<{
    db: D1Database;
    artifacts: R2Bucket;
    identity: () => Promise<unknown>;
    step: (
      input: Readonly<{ artifactDigest: string; evidence: RecoveryClosedSourceEvidence }>
    ) => Promise<Pick<Response, "status" | "json">>;
    interrupt: (
      input: Readonly<{ artifactDigest: string; evidence: RecoveryClosedSourceEvidence }>
    ) => Promise<Pick<Response, "status" | "json">>;
    facts: () => Promise<unknown>;
    bootstrapRefusal: () => Promise<unknown>;
    activateFixture: () => Promise<Pick<Response, "status">>;
  }>,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const built = yield* wait(() =>
    Bun.build({
      entrypoints: [new URL("./import-worker.test-fixture.ts", import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers", "node:*"],
    })
  );
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return yield* Effect.die(Error("Native import fixture build failed"));
  }
  const contents = yield* wait(() => output.text());
  const native = runtime(contents);
  yield* Effect.addFinalizer(() => wait(() => native.dispose()));
  const worker = yield* wait(() => native.getWorker());
  const bindings = yield* wait(() => native.getBindings<{ DB: D1Database; ARTIFACTS: R2Bucket }>());
  return {
    db: bindings.DB,
    artifacts: bindings.ARTIFACTS,
    identity: () => worker.fetch("https://import/identity").then((response) => response.json()),
    step: (input) => worker.fetch("https://import/step", { method: "POST", body: encode(input) }),
    interrupt: (input) =>
      worker.fetch("https://import/step", {
        method: "POST",
        headers: { "x-fixture-drop-import-reply": "1" },
        body: encode(input),
      }),
    activateFixture: () => worker.fetch("https://import/activate-fixture"),
    bootstrapRefusal: () =>
      worker.fetch("https://import/bootstrap-refusal").then((response) => response.json()),
    facts: () => worker.fetch("https://import/facts").then((response) => response.json()),
  };
});
