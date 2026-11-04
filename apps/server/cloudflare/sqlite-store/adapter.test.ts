import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
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
                exports: { AdapterProof: { type: "durable-object", storage: "sqlite" } },
                env: {
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
