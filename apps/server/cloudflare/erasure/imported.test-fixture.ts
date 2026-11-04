import { Effect, Schema, type Scope } from "effect";
import { Miniflare } from "miniflare";
import { makeRemoteSqliteDatabase } from "../sqlite-store/operations";
import type { RecoveryClosedSourceEvidence } from "../recovery-activation/contract";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const artifactDigestLength = 64;
const moduleText = Effect.gen(function* () {
  const built = yield* wait(() =>
    Bun.build({
      entrypoints: [new URL("./imported-worker.test-fixture.ts", import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers", "node:*"],
    })
  );
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return yield* Effect.die(Error("Imported erasure fixture failed"));
  }
  return yield* wait(() => output.text());
});
export const nativeImportedErasure: Effect.Effect<
  Readonly<{
    db: D1Database;
    bucket: R2Bucket;
    prepare: (evidence: RecoveryClosedSourceEvidence) => Promise<Pick<Response, "status" | "json">>;
    verify: (evidence: RecoveryClosedSourceEvidence) => Promise<Pick<Response, "status" | "json">>;
    interrupt: (
      evidence: RecoveryClosedSourceEvidence
    ) => Promise<Pick<Response, "status" | "json">>;
    marker: () => Promise<unknown>;
    custody: () => Promise<unknown>;
    identity: () => Promise<unknown>;
  }>,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const contents = yield* moduleText;
  const native = new Miniflare({
    workers: [
      {
        config: {
          name: "imported-erasure",
          type: "worker",
          compatibilityDate: "2026-09-18",
          exports: { ImportedErasureProof: { type: "durable-object", storage: "sqlite" } },
          env: {
            SQLITE_STORE_MANIFEST: { type: "text", value: "imported-fixture" },
            SQLITE_STORE_EPOCH: { type: "text", value: "next-epoch" },
            SQLITE_STORE_NAMESPACE_ID: { type: "text", value: "native-import" },
            SQLITE_STORE_ARTIFACT_DIGEST: { type: "text", value: "a".repeat(artifactDigestLength) },
            REGISTRY: { type: "r2", name: "imported-registry" },
            STORE: {
              type: "durable-object",
              worker: "imported-erasure",
              exportName: "ImportedErasureProof",
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
  yield* Effect.addFinalizer(() => wait(() => native.dispose()));
  const worker = yield* wait(() => native.getWorker());
  const bindings = yield* wait(() => native.getBindings<{ REGISTRY: R2Bucket }>());
  const command = (
    action: string,
    evidence: RecoveryClosedSourceEvidence
  ): Promise<Pick<Response, "status" | "json">> =>
    worker.fetch("https://imported/", { method: "POST", body: encode({ action, evidence }) });
  return {
    db: makeRemoteSqliteDatabase({
      manifest: "imported-fixture",
      epoch: "next-epoch",
      store: {
        query: (request) =>
          worker
            .fetch("https://imported/query", { method: "POST", body: encode(request) })
            .then((response) => response.json()),
      },
    }),
    bucket: bindings.REGISTRY,
    prepare: (evidence) => command("prepare", evidence),
    verify: (evidence) => command("verify", evidence),
    interrupt: (evidence) => command("interrupt", evidence),
    marker: () => worker.fetch("https://imported/marker").then((response) => response.json()),
    custody: () => worker.fetch("https://imported/custody").then((response) => response.json()),
    identity: () => worker.fetch("https://imported/identity").then((response) => response.json()),
  };
});
