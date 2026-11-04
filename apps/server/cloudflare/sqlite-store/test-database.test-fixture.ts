import { Option, Schema } from "effect";
import { Miniflare } from "miniflare";
import { makeRemoteSqliteDatabase } from "./operations";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json));
let bundled = Option.none<Promise<string>>();
const moduleText = (): Promise<string> => {
  if (Option.isSome(bundled)) return bundled.value;
  const result = Bun.build({
    entrypoints: [new URL("./adapter-worker.test-fixture.ts", import.meta.url).pathname],
    target: "browser",
    external: ["cloudflare:workers", "node:*"],
  }).then((result) => {
    const output = result.outputs[0];
    if (!result.success || output === undefined) throw new Error("SQLite fixture build failed");
    return output.text();
  });
  bundled = Option.some(result);
  return result;
};
const poolSize = 16;
const runtime = (sequence: number): Promise<Miniflare> =>
  moduleText().then((module) => {
    const buckets: Record<string, { type: "r2"; name: string }> = {};
    for (let index = 0; index < poolSize; index++) {
      buckets[`BUCKET_${index}`] = { type: "r2", name: `sqlite-${sequence}-${index}` };
    }
    return new Miniflare({
      workers: [
        {
          config: {
            name: "sqlite-owner-fixture",
            type: "worker",
            compatibilityDate: "2026-09-08",
            exports: { ActiveStoreProof: { type: "durable-object", storage: "sqlite" } },
            env: {
              ...buckets,
              SQLITE_STORE_EPOCH: { type: "text", value: "fixture" },
              SQLITE_STORE_NAMESPACE_ID: { type: "text", value: "native-fixture" },
              SQLITE_STORE_MANIFEST: { type: "text", value: "fixture" },
              STORE: {
                type: "durable-object",
                worker: "sqlite-owner-fixture",
                exportName: "ActiveStoreProof",
              },
            },
            manifest: {
              mainModule: "index.mjs",
              modules: { "index.mjs": { type: "esm", contents: module } },
            },
          },
        },
      ],
    });
  });
const database = (input: Readonly<{ runtime: Miniflare; index: number }>): D1Database =>
  makeRemoteSqliteDatabase({
    manifest: "fixture",
    epoch: "fixture",
    store: {
      query: (request) =>
        input.runtime
          .dispatchFetch("https://fixture.internal/rpc", {
            method: "POST",
            headers: {
              "x-store-manifest": request.manifest,
              "x-store-epoch": request.epoch,
              "x-store-object": `owner-${input.index}`,
            },
            body: encodeJson(request.query),
          })
          .then((response) => response.json()),
    },
  });

/** Test-only transport selection reuses the existing canonical suites against real native Store objects. */
export const sqliteTestStorage = (): Readonly<{
  acquire: () => Promise<Readonly<{ db: D1Database; bucket: R2Bucket }>>;
  dispose: () => Promise<void>;
}> => {
  const runtimes: Promise<Miniflare>[] = [];
  let next = poolSize;
  let active = Option.none<Promise<Miniflare>>();
  const acquire = (): Promise<Readonly<{ db: D1Database; bucket: R2Bucket }>> => {
    if (next === poolSize) {
      active = Option.some(runtime(runtimes.length));
      runtimes.push(Option.getOrThrow(active));
      next = 0;
    }
    const index = next++;
    return Option.getOrThrow(active).then((runtime) =>
      runtime.getBindings<{ [key: `BUCKET_${number}`]: R2Bucket }>().then((bindings) => ({
        db: database({ runtime, index }),
        bucket: Option.getOrThrow(Option.fromUndefinedOr(bindings[`BUCKET_${index}`])),
      }))
    );
  };
  return {
    acquire,
    dispose: () =>
      Promise.all(runtimes.map((runtime) => runtime.then((runtime) => runtime.dispose()))).then(
        () => undefined
      ),
  };
};
