import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { Miniflare } from "miniflare";

for (const pending of ["fetch", "body-cancel", "body-rejected"] as const) {
  it.live(`native ${pending} survives local Effect timeout and blocks release after close`, () =>
    Effect.gen(function* () {
      const built = yield* Effect.tryPromise(() =>
        Bun.build({
          entrypoints: [new URL("./outbound-worker.test-fixture.ts", import.meta.url).pathname],
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
              name: "lifecycle-outbound",
              type: "worker",
              compatibilityDate: "2026-09-08",
              exports: {
                RecoveryAdmissionGate: { type: "durable-object", storage: "sqlite" },
                HttpOwner: { type: "durable-object", storage: "sqlite" },
                HeldProvider: { type: "durable-object", storage: "sqlite" },
              },
              env: {
                RECOVERY_SOURCE_EPOCH: { type: "text", value: "source-epoch" },
                PROVIDER: {
                  type: "durable-object",
                  worker: "lifecycle-outbound",
                  exportName: "HeldProvider",
                },
                RECOVERY_ADMISSION: {
                  type: "durable-object",
                  worker: "lifecycle-outbound",
                  exportName: "RecoveryAdmissionGate",
                },
                OWNER: {
                  type: "durable-object",
                  worker: "lifecycle-outbound",
                  exportName: "HttpOwner",
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
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
      );
      const worker = yield* Effect.tryPromise(() => runtime.getWorker());
      const fetch = (path: string): ReturnType<typeof worker.fetch> =>
        worker.fetch(`https://native-lifecycle${path}`);
      expect(
        (yield* Effect.tryPromise(() => fetch(pending === "fetch" ? "/start" : "/start-cancel")))
          .status
      ).toBe(200);
      expect(
        yield* Effect.tryPromise(() => fetch("/inspect").then((response) => response.json()))
      ).toMatchObject({ leases: 1 });
      yield* Effect.tryPromise(() => fetch("/close"));
      yield* Effect.tryPromise(() =>
        fetch(
          {
            fetch: "/release",
            "body-cancel": "/cancel-release",
            "body-rejected": "/cancel-reject",
          }[pending]
        )
      );
      expect(
        yield* Effect.tryPromise(() => fetch("/result").then((response) => response.json()))
      ).toEqual({ status: 503 });
      expect(
        yield* Effect.tryPromise(() => fetch("/inspect").then((response) => response.json()))
      ).toMatchObject({ closed: true, leases: pending === "body-rejected" ? 1 : 0 });
    }).pipe(Effect.scoped)
  );
}
