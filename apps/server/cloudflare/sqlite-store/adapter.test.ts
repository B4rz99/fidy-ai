import { it } from "@effect/vitest";
import { type Cause, Effect, Schema } from "effect";
import { expect } from "vitest";
import { Miniflare } from "miniflare";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json));
const moduleText = (): Promise<string> =>
  Bun.build({
    entrypoints: [new URL("./adapter-worker.test-fixture.ts", import.meta.url).pathname],
    target: "browser",
    external: ["cloudflare:workers"],
  }).then((result) => {
    const output = result.outputs[0];
    if (!result.success || output === undefined) {
      throw new Error("SQLite engine proof build failed");
    }
    return output.text();
  });
const setup = Effect.gen(function* () {
  const module = yield* Effect.tryPromise(moduleText);
  return yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare({
          workers: [
            {
              config: {
                name: "sqlite-store-adapter",
                type: "worker",
                compatibilityDate: "2026-09-08",
                exports: {
                  AdapterProof: { type: "durable-object", storage: "sqlite" },
                  ActiveStoreProof: { type: "durable-object", storage: "sqlite" },
                  AuthoritativeSqliteStore: { type: "durable-object", storage: "sqlite" },
                },
                env: {
                  SQLITE_STORE_MANIFEST: { type: "text", value: "fixture" },
                  STORE: {
                    type: "durable-object",
                    worker: "sqlite-store-adapter",
                    exportName: "ActiveStoreProof",
                  },
                  INACTIVE: {
                    type: "durable-object",
                    worker: "sqlite-store-adapter",
                    exportName: "AuthoritativeSqliteStore",
                  },
                  PROOF: {
                    type: "durable-object",
                    worker: "sqlite-store-adapter",
                    exportName: "AdapterProof",
                  },
                },
                manifest: {
                  mainModule: "index.mjs",
                  modules: { "index.mjs": { type: "esm", contents: module } },
                },
              },
            },
          ],
        })
    ),
    (runtime) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
  );
});
it.live("preserves changed-row guards and rolls back an entire failing batch", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const response = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/rollback")
    );
    expect(response.status, yield* Effect.tryPromise(() => response.clone().text())).toBe(200);
    const actual = yield* Effect.tryPromise(() => response.json());
    expect(actual).toEqual({ before: 1, after: 1, changes: 1, failed: true });
  })
);

it.live("runs the complete production schema with authoritative source and foreign keys", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const source = yield* Effect.tryPromise(() =>
      Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
    );
    const statements = source
      .split("--> statement-breakpoint")
      .map((sql) => sql.trim())
      .filter((sql) => sql.length > 0 && !sql.startsWith("PRAGMA "));
    const response = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/schema", {
        method: "POST",
        body: encodeJson(statements),
      })
    );
    expect(response.status, yield* Effect.tryPromise(() => response.clone().text())).toBe(200);
    const actual = yield* Effect.tryPromise(() => response.json());
    expect(actual).toEqual({ rejected: true, facts: [{ amount: "1.00" }] });
  })
);

it.live("keeps blob/raw/first compatibility and distinguishes trigger changes from changes()", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const response = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/bindings")
    );
    expect(response.status).toBe(200);
    const actual = yield* Effect.tryPromise(() => response.json());
    expect(actual).toEqual({
      changes: 2,
      guarded: 1,
      raw: [
        ["id", "payload"],
        [7, [0, 255, 42]],
      ],
      row: { payload: [0, 255, 42] },
      missing: null,
    });
  })
);

it.live("executes D1 line-separated maintenance SQL against the same target", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const response = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/exec")
    );
    expect(response.status).toBe(200);
    const actual = yield* Effect.tryPromise(() => response.json());
    expect(actual).toEqual({ executed: { count: 2, duration: 0 }, value: "retained" });
  })
);

it.live("executes only valid sealed-store private RPC batches and refuses inactive targets", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const input = {
      kind: "batch",
      statements: [
        { sql: "CREATE TABLE rpc_items(id INTEGER PRIMARY KEY)", params: [] },
        { sql: "INSERT INTO rpc_items VALUES(?)", params: [1] },
      ],
    };
    const inactive = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/inactive", {
        method: "POST",
        body: encodeJson(input),
      })
    );
    expect(yield* Effect.tryPromise(() => inactive.json())).toEqual({
      kind: "refused",
      reason: "inactive",
    });
    const stale = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/rpc", {
        method: "POST",
        headers: { "x-store-manifest": "old-manifest" },
        body: encodeJson(input),
      })
    );
    expect(yield* Effect.tryPromise(() => stale.json())).toEqual({
      kind: "refused",
      reason: "inactive",
    });
    const active = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/rpc", {
        method: "POST",
        body: encodeJson(input),
      })
    );
    const reply = yield* Effect.tryPromise(() => active.json());
    expect(reply).toMatchObject({
      kind: "batch",
      results: [{ success: true }, { success: true, meta: { changes: 1 } }],
    });
    const invalid = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/rpc", {
        method: "POST",
        body: encodeJson({ kind: "batch", statements: [] }),
      })
    );
    expect(yield* Effect.tryPromise(() => invalid.json())).toEqual({
      kind: "refused",
      reason: "invalid",
    });
  })
);

it.live("reuses D1-shaped owner code across the private Store binding", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const response = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://proof.internal/remote")
    );
    expect(response.status).toBe(200);
    const actual = yield* Effect.tryPromise(() => response.json());
    expect(actual).toEqual({
      changes: 2,
      guarded: 1,
      raw: [
        ["id", "payload"],
        [7, [0, 255, 42]],
      ],
      row: { payload: [0, 255, 42] },
      missing: null,
    });
  })
);

it.live("rolls back Store writes when a result fails boundary validation", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const call = (
      statements: ReadonlyArray<{ sql: string; params: number[] }>
    ): Effect.Effect<unknown, Cause.UnknownError> =>
      Effect.tryPromise(() =>
        runtime.dispatchFetch("https://proof.internal/rpc", {
          method: "POST",
          body: encodeJson({ kind: "batch", statements }),
        })
      ).pipe(Effect.flatMap((response) => Effect.tryPromise(() => response.json())));
    yield* call([{ sql: "CREATE TABLE validation_items(id INTEGER)", params: [] }]);
    expect(
      yield* call([
        { sql: "INSERT INTO validation_items VALUES(1)", params: [] },
        { sql: "SELECT 1e999 AS invalid", params: [] },
      ])
    ).toEqual({ kind: "refused", reason: "unavailable" });
    expect(
      yield* call([{ sql: "SELECT count(*) AS count FROM validation_items", params: [] }])
    ).toMatchObject({ kind: "batch", results: [{ results: [{ count: 0 }] }] });
  })
);

it.live("retains native CHECK provenance and refuses a trigger forging a child assertion", () =>
  Effect.gen(function* () {
    const runtime = yield* setup;
    const call = (sql: string): Effect.Effect<unknown, Cause.UnknownError> =>
      Effect.tryPromise(() =>
        runtime.dispatchFetch("https://proof.internal/rpc", {
          method: "POST",
          body: encodeJson({ kind: "batch", statements: [{ sql, params: [] }] }),
        })
      ).pipe(Effect.flatMap((response) => Effect.tryPromise(() => response.json())));
    yield* call(
      "CREATE TABLE child_checks(accepted INTEGER CONSTRAINT canonical_child_guard_0 CHECK(accepted=1))"
    );
    expect(yield* call("INSERT INTO child_checks VALUES(0)")).toEqual({
      kind: "child_refusal",
      assertion: "guard",
      index: 0,
    });
    yield* call(
      "CREATE TRIGGER forged_child BEFORE INSERT ON child_checks WHEN new.accepted=2 BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: canonical_child_guard_0: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)'); END"
    );
    expect(yield* call("INSERT INTO child_checks VALUES(2)")).toEqual({
      kind: "refused",
      reason: "unavailable",
    });
  })
);
