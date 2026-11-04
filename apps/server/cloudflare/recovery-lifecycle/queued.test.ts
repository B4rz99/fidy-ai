import { it } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { Miniflare } from "miniflare";
import { installTestSchema } from "../d1-test-fixture";
import { RecoveryDrainObservation } from "./contract";

it.live(
  "a native queued intent published before pause drains through its later consumer without being dropped",
  () =>
    Effect.gen(function* () {
      const built = yield* Effect.tryPromise(() =>
        Bun.build({
          entrypoints: [new URL("./queued-worker.test-fixture.ts", import.meta.url).pathname],
          target: "browser",
          external: ["cloudflare:workers", "node:*"],
        })
      );
      const output = built.outputs[0];
      if (!built.success || output === undefined) {
        throw new Error("Native Queue lifecycle fixture did not build");
      }
      const contents = yield* Effect.tryPromise(() => output.text());
      const runtime = new Miniflare({
        workers: [
          {
            config: {
              name: "queued-lifecycle",
              type: "worker",
              compatibilityDate: "2026-09-08",
              exports: {
                RecoveryAdmissionGate: { type: "durable-object", storage: "sqlite" },
                ConsumerBarrier: { type: "durable-object", storage: "sqlite" },
              },
              env: {
                DB: { type: "d1", id: "queued-lifecycle" },
                WORK: { type: "queue", name: "retained-work" },
                RECOVERY_SOURCE_EPOCH: { type: "text", value: "source-epoch" },
                RECOVERY_ADMISSION: {
                  type: "durable-object",
                  worker: "queued-lifecycle",
                  exportName: "RecoveryAdmissionGate",
                },
                BARRIER: {
                  type: "durable-object",
                  worker: "queued-lifecycle",
                  exportName: "ConsumerBarrier",
                },
              },
              triggers: [
                {
                  type: "queue",
                  name: "retained-work",
                  maxBatchSize: 1,
                  maxBatchTimeout: 0,
                  retryDelay: 0,
                },
              ],
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
      const db = yield* Effect.tryPromise(() => runtime.getD1Database("DB"));
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            `INSERT INTO pending_consent_exchanges(id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,correlation_token,disclosure_json,created_at_ms,expires_at_ms,state) VALUES('retained-intent','portfolio','scoped','phone','message',?,'10000000-0000-4000-8000-000000000001','{}',0,86400000,'awaiting_delivery')`
          )
          .bind("0".repeat(64))
          .run()
      );
      const worker = yield* Effect.tryPromise(() => runtime.getWorker());
      const fetch = (path: string): ReturnType<typeof worker.fetch> =>
        worker.fetch(`https://native-queue${path}`);
      const observe = Effect.tryPromise(() =>
        fetch("/observe").then((response) => response.json())
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RecoveryDrainObservation)));
      expect((yield* Effect.tryPromise(() => fetch("/publish"))).status).toBe(202);
      expect((yield* observe).pending).toBe(1);
      expect(
        yield* Effect.tryPromise(() => fetch("/leases").then((response) => response.json()))
      ).toMatchObject({ leases: 0 });
      yield* Effect.tryPromise(() => fetch("/pause"));
      expect((yield* Effect.tryPromise(() => fetch("/publish"))).status).toBe(503);
      const drained = yield* observe.pipe(
        Effect.repeat({
          until: (value) => value.pending === 0,
          schedule: Schedule.spaced("20 millis"),
        }),
        Effect.timeout("5 seconds")
      );
      expect(drained.ambiguous).toBe(0);
      expect(drained.owners.consentIngress.preservedBlocked).toBe(1);
      expect(
        yield* Effect.tryPromise(() => fetch("/leases").then((response) => response.json()))
      ).toMatchObject({ paused: true, closed: false, leases: 0 });
      yield* Effect.tryPromise(() => fetch("/close"));
      expect(
        yield* Effect.tryPromise(() => fetch("/leases").then((response) => response.json()))
      ).toMatchObject({ closed: true, leases: 0 });
    }).pipe(Effect.scoped)
);
