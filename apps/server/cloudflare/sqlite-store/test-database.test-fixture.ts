import type { NativeDashboardBinding, NativeDashboardReader } from "../dashboard/contract";
import type { SqliteStoreBinding } from "./contract";
import { makeNativeDashboardReader } from "../dashboard/operations";
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
type NativeFixtureConfiguration = Readonly<{
  browserOrigin: string;
  clockOffset: Option.Option<number>;
}>;
const defaultNativeConfiguration: NativeFixtureConfiguration = {
  browserOrigin: "https://app.fidy.test",
  clockOffset: Option.none(),
};
const nativeClockBindings = (
  configuration: NativeFixtureConfiguration
): Readonly<Record<string, { type: "text"; value: string }>> => ({
  BROWSER_ORIGIN: { type: "text", value: configuration.browserOrigin },
  FIDY_TEST_CLOCK_OFFSET: {
    type: "text",
    value: Option.match(configuration.clockOffset, { onNone: () => "", onSome: String }),
  },
});
const runtime = (
  sequence: number,
  isolation: "Live" | "Isolated" = "Live",
  configuration: NativeFixtureConfiguration = defaultNativeConfiguration
): Promise<Miniflare> =>
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
            compatibilityFlags: ["nodejs_compat"],
            exports: { ActiveStoreProof: { type: "durable-object", storage: "sqlite" } },
            env: {
              ...buckets,
              RECOVERY_ISOLATION: {
                type: "text",
                value: isolation === "Isolated" ? "isolated" : "",
              },
              ERASURE_BUCKET: { type: "r2", name: `sqlite-${sequence}-0` },
              SQLITE_STORE: {
                type: "durable-object",
                worker: "sqlite-owner-fixture",
                exportName: "ActiveStoreProof",
              },
              DOCUMENTS: {
                type: "worker",
                worker: "sqlite-owner-fixture",
                exportName: "AssessmentDocumentService",
              },
              ...nativeClockBindings(configuration),
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
const database = (input: Readonly<{ runtime: Miniflare; name: string }>): D1Database =>
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
              "x-store-object": input.name,
            },
            body: encodeJson(request.query),
          })
          .then((response) => response.json()),
    },
  });

type TestStore = Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  document: (request: Request) => Promise<unknown>;
  snapshot: NativeDashboardReader;
}>;
type NativeTestStore = TestStore &
  Readonly<{
    namespace: Readonly<{
      getByName: (name: string) => SqliteStoreBinding & NativeDashboardBinding;
    }>;
  }>;
const snapshot = (input: Readonly<{ runtime: Miniflare; name: string }>): NativeDashboardReader =>
  makeNativeDashboardReader({
    manifest: "fixture",
    epoch: "fixture",
    nativeCall: (execute) => execute(),
    store: {
      dashboard: (call) =>
        call.mode === "oauth"
          ? input.runtime
              .getBindings<{ SQLITE_STORE: NativeTestStore["namespace"] }>()
              .then(({ SQLITE_STORE }) => SQLITE_STORE.getByName(input.name).dashboard(call))
          : input.runtime
              .dispatchFetch("https://fixture.internal/dashboard-snapshot", {
                method: "POST",
                headers: { "x-store-object": input.name },
                body: encodeJson({
                  url: call.request.url,
                  method: call.request.method,
                  headers: Object.fromEntries(call.request.headers),
                  mode: call.mode,
                }),
              })
              .then((response) => response.json()),
    },
  });

/** Test-only transport selection reuses the existing canonical suites against real native Store objects. */
export const sqliteTestStorage = (): Readonly<{
  acquire: () => Promise<TestStore>;
  acquireDocument: (
    isolation: "Live" | "Isolated",
    configuration?: NativeFixtureConfiguration
  ) => Promise<NativeTestStore>;
  dispose: () => Promise<void>;
}> => {
  const runtimes: Promise<Miniflare>[] = [];
  let next = poolSize;
  let active = Option.none<Promise<Miniflare>>();
  const acquire = (): Promise<TestStore> => {
    if (next === poolSize) {
      active = Option.some(runtime(runtimes.length));
      runtimes.push(Option.getOrThrow(active));
      next = 0;
    }
    const index = next++;
    return Option.getOrThrow(active).then((runtime) =>
      runtime.getBindings<{ [key: `BUCKET_${number}`]: R2Bucket }>().then((bindings) => ({
        db: database({ runtime, name: `owner-${index}` }),
        snapshot: snapshot({ runtime, name: `owner-${index}` }),
        document: (request: Request) => documentRead(runtime, request),
        bucket: Option.getOrThrow(Option.fromUndefinedOr(bindings[`BUCKET_${index}`])),
      }))
    );
  };
  return {
    acquire,
    acquireDocument: (isolation, configuration = defaultNativeConfiguration) => {
      const next = runtime(runtimes.length, isolation, configuration);
      runtimes.push(next);
      return next.then((runtime) =>
        runtime
          .getBindings<{
            BUCKET_0: R2Bucket;
            SQLITE_STORE: NativeTestStore["namespace"];
            DOCUMENTS: Readonly<{ readDashboardDocument: (request: Request) => Promise<unknown> }>;
          }>()
          .then((bindings) => ({
            db: database({ runtime, name: "authoritative-v1" }),
            snapshot: snapshot({ runtime, name: "authoritative-v1" }),
            bucket: bindings.BUCKET_0,
            namespace: bindings.SQLITE_STORE,
            document: (request: Request) =>
              Promise.resolve(bindings.DOCUMENTS.readDashboardDocument(request)),
          }))
      );
    },
    dispose: () =>
      Promise.all(runtimes.map((runtime) => runtime.then((runtime) => runtime.dispose()))).then(
        () => undefined
      ),
  };
};

const documentRead = (runtime: Miniflare, request: Request): Promise<unknown> =>
  runtime
    .dispatchFetch("https://fixture.internal/document-entry", {
      method: "POST",
      body: encodeJson({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        mode: "document",
      }),
    })
    .then((response) => response.json());
