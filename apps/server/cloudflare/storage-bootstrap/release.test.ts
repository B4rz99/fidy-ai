import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { Miniflare } from "miniflare";
import { expect } from "vitest";
import { browserOrigins } from "../runtime/contract";
import { SmokeIdentity, smokePath, smokeProofHeader } from "../runtime/release-smoke/contract";
import { native, workerManifest } from "../user-store.test-fixture";
import { SharedStoreMarkers, bootstrapQuery, compatibilityQuery } from "./contract";

const origin = "https://api.fidyapp.com";
const proof = "a".repeat(64);
const user = "10000000-0000-4000-8000-000000000051";
const objectTypes = {
  USER_STORE: "UserStore",
  DIRECTORY: "Directory",
  PRICING: "Pricing",
  MAINTENANCE: "Maintenance",
  ERASURE: "Erasure",
};
const text = (value: string): { type: "text"; value: string } => ({ type: "text" as const, value });
const objects = Object.fromEntries(
  Object.entries(objectTypes).map(([key, exportName]) => [
    key,
    { type: "durable-object" as const, worker: "owners", exportName },
  ])
);
const classes = Object.fromEntries(
  Object.values(objectTypes).map((name) => [
    name,
    { type: "durable-object" as const, storage: "sqlite" as const },
  ])
);
const common = {
  type: "worker" as const,
  compatibilityDate: "2026-09-08",
  compatibilityFlags: ["nodejs_compat"],
};
const identity = {
  RECOVERY_ISOLATION: text("isolated"),
  SMOKE_PROOF: text(proof),
  BROWSER_ORIGIN: text(browserOrigins.production),
  CF_VERSION_METADATA: { type: "version-metadata" as const },
  CONTRACT_DIGEST: text("c".repeat(64)),
  RELEASE_GIT_SHA: text("a".repeat(40)),
};

const rehearse = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-storage-release-" });
  const [ingress, core, advanced] = yield* Effect.all(
    [
      workerManifest("./public-worker.ts"),
      workerManifest("./core-worker.ts"),
      workerManifest("./storage-forward-repair.test-fixture.ts"),
    ],
    { concurrency: 3 }
  );
  const phase = Effect.fn(function* (
    ownerModule: typeof core,
    {
      advancedState,
      first,
      readable,
    }: { advancedState: boolean; first: boolean; readable: boolean }
  ) {
    const mf = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Miniflare({
            resourcePersistencePath: path,
            unsafeInspectDurableObjects: true,
            workers: [
              {
                config: {
                  ...common,
                  name: "ingress",
                  manifest: ingress,
                  env: { ...identity, CORE: { type: "worker", worker: "core" } },
                },
              },
              {
                config: {
                  ...common,
                  name: "core",
                  manifest: core,
                  env: { ...identity, ...objects },
                },
              },
              {
                config: {
                  ...common,
                  name: "owners",
                  manifest: ownerModule,
                  exports: classes,
                  env: {
                    ...identity,
                    ...objects,
                    SQLITE_STORE_CAPACITY_BYTES: text("1000000000"),
                  },
                },
              },
              {
                config: {
                  ...common,
                  name: "mapping",
                  manifest: {
                    mainModule: "index.mjs",
                    modules: {
                      "index.mjs": {
                        type: "esm",
                        contents: `export default {async fetch(req, env) {if (new URL(req.url).pathname === "/offers") return env.PRICING.getByName("pricing").fetch("https://pricing.invalid/offers"); const id = env.USER_STORE.idFromName("${user}"); await env.USER_STORE.get(id).fetch("https://user.invalid/unused"); return new Response(id.toString())}}`,
                      },
                    },
                  },
                  env: objects,
                },
              },
            ],
          })
      ),
      (mf) => native(() => mf.dispose())
    );
    if (first) {
      const readiness = yield* native(() =>
        mf.dispatchFetch(origin + smokePath + "?readiness=1", {
          headers: { [smokeProofHeader]: proof },
        })
      );
      expect(readiness.status).toBe(200);
      const health = yield* native(() => mf.dispatchFetch(origin + "/health"));
      expect(health.status).toBe(200);
    }
    const ordinary = yield* native(() => mf.dispatchFetch(origin + "/transactions"));
    expect(ordinary.status).toBe(503);
    const denied = yield* native(() =>
      mf.dispatchFetch(origin + smokePath + bootstrapQuery, { method: "POST" })
    );
    expect(denied.status).toBe(503);
    const probe = yield* native(() =>
      mf.dispatchFetch(origin + smokePath + bootstrapQuery, {
        method: "POST",
        headers: { [smokeProofHeader]: proof },
      })
    );
    if (!readable) {
      expect(probe.status).toBe(503);
      return;
    }
    expect(probe.status).toBe(200);
    const body = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        core: SmokeIdentity,
        markers: SharedStoreMarkers,
      })
    )(yield* native(() => probe.json()));
    expect(probe.headers.get("x-fidy-smoke-worker-version")).not.toBe(body.core.workerVersionId);
    const overlap = yield* native(() =>
      mf.dispatchFetch(origin + smokePath + compatibilityQuery, {
        headers: { [smokeProofHeader]: proof },
      })
    );
    expect(overlap.status).toBe(200);
    expect(yield* native(() => overlap.json())).toEqual(body);
    const mapping = yield* native(() =>
      mf
        .getWorker("mapping")
        .then((worker) => worker.fetch("https://mapping.invalid"))
        .then((response) => response.text())
    );
    const local = yield* native(() =>
      mf.unsafeGetDurableObjectStorage("owners", "UserStore", { name: user })
    );
    const directory = yield* native(() =>
      mf.unsafeGetDurableObjectStorage("owners", "Directory", { name: "directory-v1" })
    );
    const offers = yield* native(() =>
      mf
        .getWorker("mapping")
        .then((worker) => worker.fetch("https://mapping.invalid/offers"))
        .then((response) => response.json())
    );
    expect(offers).toHaveLength(3);
    if (first) {
      yield* native(() =>
        local.exec(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',1)",
          user
        )
      );
    }
    expect(yield* native(() => local.exec("SELECT id FROM users"))).toEqual([{ id: user }]);
    expect(
      yield* native(() =>
        directory.exec("SELECT count(*) AS n FROM sqlite_schema WHERE name='release_rehearsal'")
      )
    ).toEqual([{ n: advancedState ? 1 : 0 }]);
    expect(body.markers.directory.workerVersionId).not.toBe(body.core.workerVersionId);
    return { mapping, markers: body.markers.directory.history };
  });
  const initial = yield* Effect.scoped(
    phase(core, { advancedState: false, first: true, readable: true })
  );
  const compatible = yield* Effect.scoped(
    phase(core, { advancedState: false, first: false, readable: true })
  );
  expect(compatible).toEqual(initial);
  const upgrade = yield* Effect.scoped(
    phase(advanced, { advancedState: true, first: false, readable: true })
  );
  expect(upgrade?.mapping).toBe(initial?.mapping);
  expect(upgrade?.markers.slice(0, -1)).toEqual(initial?.markers);
  yield* Effect.scoped(phase(core, { advancedState: true, first: false, readable: false }));
  expect(
    yield* Effect.scoped(phase(advanced, { advancedState: true, first: false, readable: true }))
  ).toEqual(upgrade);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "installs native shared facts under closed admission and keeps named User data through mixed-version rollback and forward repair",
    () => rehearse,

    60_000
  );
});
