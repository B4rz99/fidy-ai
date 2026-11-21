import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Miniflare } from "miniflare";
import { expect } from "vitest";
import { native } from "../../user-store.test-fixture";

const capacityEvidence = Schema.Struct({
  owner: Schema.Literals(["user", "directory", "pricing", "maintenance", "erasure"]),
  band: Schema.Literals(["normal", "warning", "restricted"]),
  bytes: Schema.Int,
  ceilingBytes: Schema.Int,
  effects: Schema.Int,
  accountability: Schema.Int,
  padding: Schema.Int,
  originalDeadline: Schema.Int,
});

const encoded = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.live(
  "protects required writes and retained deadlines at every owner capacity boundary",
  Effect.fnUntraced(function* () {
    const built = yield* native(() =>
      Bun.build({
        entrypoints: [new URL("./capacity.test-fixture.ts", import.meta.url).pathname],
        target: "browser",
        external: ["cloudflare:workers"],
      })
    );

    const output = built.outputs[0];

    if (!built.success || output === undefined) {
      return yield* Effect.die(new Error("Capacity probe build failed"));
    }

    const contents = yield* native(() => output.text());

    const runtime = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Miniflare({
            workers: [
              {
                config: {
                  type: "worker",
                  name: "capacity",
                  compatibilityDate: "2026-09-08",
                  env: {
                    PROBE: {
                      type: "durable-object",
                      worker: "capacity",
                      exportName: "CapacityProbe",
                    },
                  },
                  exports: { CapacityProbe: { type: "durable-object", storage: "sqlite" } },
                  manifest: {
                    mainModule: "worker.mjs",
                    modules: {
                      "worker.mjs": { type: "esm", contents: contents + "\nexport default {};" },
                    },
                  },
                },
              },
            ],
          })
      ),
      (mf) => native(() => mf.dispose())
    );

    const namespace = yield* native(() => runtime.getDurableObjectNamespace("PROBE"));

    yield* Effect.forEach(
      ["user", "directory", "pricing", "maintenance", "erasure"] as const,
      Effect.fnUntraced(function* (owner) {
        const stub = namespace.getByName(owner);

        const request = (action: string): Effect.Effect<Awaited<ReturnType<typeof stub.fetch>>> =>
          native(() => stub.fetch("https://capacity.test/" + action));

        const evidence = Effect.fnUntraced(function* (action: string) {
          const reply = yield* request(action);
          expect(reply.status).toBe(200);

          return yield* Schema.decodeUnknownEffect(capacityEvidence)(
            yield* native(() => reply.json())
          );
        });

        const normal = yield* evidence("status");
        expect(normal.band).toBe("normal");
        expect((yield* request("overflow")).status).toBe(503);
        expect(yield* evidence("status")).toMatchObject({
          effects: 0,
          accountability: 0,
          originalDeadline: 123456,
        });
        const warning = yield* evidence("warn");
        expect(warning.band).toBe("warning");
        expect((yield* evidence("ordinary")).effects).toBe(1);
        const restricted = yield* evidence("restrict");
        expect(restricted.band).toBe("restricted");
        expect((yield* request("ordinary")).status).toBe(503);
        const required = yield* evidence("required");
        expect(required).toMatchObject({
          owner,
          effects: 2,
          accountability: 2,
          originalDeadline: 123456,
        });
        expect((yield* request("full")).status).toBe(503);
        const cleaned = yield* evidence("cleanup");
        expect(cleaned).toMatchObject({
          padding: 0,
          effects: 2,
          accountability: 2,
          originalDeadline: 123456,
        });
        process.stdout.write(
          `STORE_CAPACITY ${encoded({ owner, ceilingBytes: normal.ceilingBytes, warningBytes: warning.bytes, restrictedBytes: restricted.bytes, requiredPeakBytes: required.bytes, afterCleanupBytes: cleaned.bytes })}\n`
        );
      }),
      { discard: true }
    );
  }, Effect.scoped)
);
