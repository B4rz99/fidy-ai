import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { Miniflare } from "miniflare";

it.live("native Effect schedulers keep concurrent DB/R2 children with their own root lease", () =>
  Effect.gen(function* () {
    const built = yield* Effect.tryPromise(() =>
      Bun.build({
        entrypoints: [new URL("./concurrency.test-fixture.ts", import.meta.url).pathname],
        target: "browser",
        external: ["cloudflare:workers", "node:*"],
      })
    );
    const output = built.outputs[0];
    if (!built.success || output === undefined) {
      throw new Error("Native concurrency fixture did not build");
    }
    const contents = yield* Effect.tryPromise(() => output.text());
    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: "lifecycle-concurrency",
            type: "worker",
            compatibilityDate: "2026-09-08",
            exports: {
              RecoveryAdmissionGate: { type: "durable-object", storage: "sqlite" },
              ConcurrentOwner: { type: "durable-object", storage: "sqlite" },
            },
            env: {
              RECOVERY_SOURCE_EPOCH: { type: "text", value: "source-epoch" },
              DB: { type: "d1", id: "lifecycle-native-db" },
              BUCKET: { type: "r2", name: "lifecycle-native-bucket" },
              RECOVERY_ADMISSION: {
                type: "durable-object",
                worker: "lifecycle-concurrency",
                exportName: "RecoveryAdmissionGate",
              },
              OWNER: {
                type: "durable-object",
                worker: "lifecycle-concurrency",
                exportName: "ConcurrentOwner",
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
    yield* Effect.addFinalizer(() => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie));
    const worker = yield* Effect.tryPromise(() => runtime.getWorker());
    const fetch = (path: string): ReturnType<typeof worker.fetch> =>
      worker.fetch(`https://native-lifecycle${path}`);
    expect((yield* Effect.tryPromise(() => fetch("/start"))).status).toBe(200);
    expect((yield* Effect.tryPromise(() => fetch("/other"))).status).toBe(200);
    expect(
      yield* Effect.tryPromise(() => fetch("/inspect").then((response) => response.json()))
    ).toMatchObject({ leases: 1 });
    expect(yield* Effect.tryPromise(() => fetch("/late").then((response) => response.text()))).toBe(
      "denied"
    );
    yield* Effect.tryPromise(() => fetch("/close"));
    expect(
      yield* Effect.tryPromise(() => fetch("/release").then((response) => response.json()))
    ).toEqual({ status: 503 });
    expect(
      yield* Effect.tryPromise(() => fetch("/inspect").then((response) => response.json()))
    ).toMatchObject({ closed: true, leases: 0 });
    expect(
      yield* Effect.tryPromise(() => fetch("/objects").then((response) => response.json()))
    ).toEqual({ lateWritten: false });
  }).pipe(Effect.scoped)
);
