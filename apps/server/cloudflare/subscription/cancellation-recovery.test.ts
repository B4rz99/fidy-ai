import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Array as Arr, Effect, FileSystem } from "effect";
import { expect } from "vitest";
import { Miniflare } from "miniflare";
import { native } from "../user-store.test-fixture";

const platform = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-cancellation-" });

  const built = yield* native(() =>
    Bun.build({
      entrypoints: [new URL("./cancellation-recovery.test-fixture.ts", import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers", "node:*"],
    })
  );

  const output = built.outputs[0];

  if (output === undefined) {
    return yield* Effect.die(new Error("Cancellation fixture bundle missing"));
  }

  const contents = yield* native(() => output.text());

  const create = (): Miniflare =>
    new Miniflare({
      resourcePersistencePath: path,
      workers: [
        {
          config: {
            name: "cancellation",
            type: "worker",
            compatibilityDate: "2026-09-08",
            compatibilityFlags: ["nodejs_compat"],
            env: {
              OWNER: {
                type: "durable-object",
                worker: "cancellation",
                exportName: "CancellationFixture",
              },
            },
            exports: { CancellationFixture: { type: "durable-object", storage: "sqlite" } },
            manifest: {
              mainModule: "index.mjs",
              modules: { "index.mjs": { type: "esm", contents } },
            },
          },
        },
      ],
    });

  let runtime = create();
  yield* Effect.addFinalizer(() => native(() => runtime.dispose()));

  const request = (action: string, owner = "user"): Effect.Effect<unknown> =>
    native(() =>
      runtime
        .getDurableObjectNamespace("OWNER")
        .then((namespace) => namespace.getByName(owner).fetch("https://owner.internal/" + action))
        .then((response) => response.json())
    );

  const restart = native(() => runtime.dispose()).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        runtime = create();
      })
    )
  );

  return { request, restart };
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "commits a paid cancellation and its recovery alarm together and preserves an earlier wake across reconstruction",
    () =>
      Effect.gen(function* () {
        const { request, restart } = yield* platform;
        expect(yield* request("seed")).toEqual({ rows: [], alarm: null });
        expect(yield* request("fail")).toEqual({ rows: [], alarm: null });
        yield* restart;
        expect(yield* request("inspect")).toEqual({ rows: [], alarm: null });

        const rows = [
          {
            state: "void-pending",
            paid_through_ms: 2_000_000_001_000,
            paid_attempt_id: "22370000-0000-4000-8000-000000000004",
          },
        ];

        expect(yield* request("accept")).toEqual({ rows, alarm: 2_000_000_000_000 });
        yield* request("earlier");
        yield* restart;
        expect(yield* request("accept")).toEqual({ rows, alarm: 1_999_999_999_000 });
      })
  );
  test.effect(
    "recovers an interrupted handoff with its exact identity and a retained cooldown",
    () =>
      Effect.gen(function* () {
        const { request, restart } = yield* platform;
        yield* request("seed");
        yield* request("accept");
        yield* restart;
        expect(yield* request("dispatch-failed")).toEqual({ offered: 1, alarm: 2_000_000_060_000 });
        expect(yield* request("dispatch")).toEqual({ offered: [], alarm: 2_000_000_060_000 });
        yield* restart;
        expect(yield* request("dispatch-later")).toMatchObject({
          offered: [
            {
              version: 3,
              kind: "source-cancellation",
              userId: "22370000-0000-4000-8000-000000000001",
              paidAttemptId: "22370000-0000-4000-8000-000000000004",
            },
          ],
        });
      })
  );
  test.effect(
    "pages a due backlog and retains the first remaining deadline after every offer fails",
    () =>
      Effect.gen(function* () {
        const { request, restart } = yield* platform;
        yield* request("seed");
        yield* request("seed-page");
        expect(yield* request("dispatch-failed")).toEqual({
          offered: 32,
          alarm: 2_000_000_000_000,
        });
        yield* restart;
        expect(yield* request("dispatch-failed")).toEqual({ offered: 2, alarm: 2_000_000_060_000 });
      })
  );
  test.effect(
    "never repeats a claimed void and only confirms the exact Wompi source after a lost response",
    () =>
      Effect.gen(function* () {
        const { request, restart } = yield* platform;
        yield* request("seed");
        yield* request("accept");
        expect(yield* request("rebind")).toEqual({ rebound: false });
        expect(yield* request("observe-lost")).toMatchObject({
          state: "void-pending",
          count: 1,
          sends: 1,
        });
        yield* restart;
        expect(yield* request("observe-duplicate")).toMatchObject({
          state: "void-pending",
          count: 1,
          sends: 0,
        });
        expect(yield* request("observe-foreign")).toMatchObject({
          state: "void-pending",
          count: 2,
          sends: 0,
        });
        expect(yield* request("observe-confirmed")).toMatchObject({
          state: "voided",
          count: 3,
          sends: 0,
        });
        expect(yield* request("observe-confirmed")).toMatchObject({
          state: "voided",
          count: 3,
          sends: 0,
        });
      })
  );
  test.effect(
    "acknowledges duplicate offers only after the exact Workflow is active and restarts its failed instance",
    () =>
      Effect.gen(function* () {
        const { request } = yield* platform;
        yield* request("seed");
        yield* request("accept");
        expect(yield* request("queue")).toEqual({
          instance:
            "source-cancel-v3-22370000-0000-4000-8000-000000000001-22370000-0000-4000-8000-000000000004",
          created: 1,
          restarted: 1,
          retryUnknown: true,
        });
      })
  );
  test.effect(
    "continues later eligible work when a family fails and repairs a missing alarm after native retries stop",
    () =>
      Effect.gen(function* () {
        const { request, restart } = yield* platform;
        yield* request("seed");
        yield* request("accept");
        yield* request("poison");

        yield* Effect.forEach(
          Arr.range(1, 7),
          Effect.fnUntraced(function* () {
            expect(yield* request("native-retry")).toMatchObject({
              failedFamilies: 1,
              attempted: 0,
            });
          }),
          { discard: true }
        );

        yield* request("exhausted");
        yield* restart;
        expect(yield* request("inspect")).toMatchObject({ alarm: null });
        expect(yield* request("recover-families")).toEqual({
          failedFamilies: 1,
          attempted: 1,
          failedOffers: 0,
          recovered: "22370000-0000-4000-8000-000000000004",
          alarm: 2_000_000_060_000,
        });
      })
  );
  test.effect(
    "upgrading an occupied v4 store preserves a capture receipt and refuses an unreviewed response body",
    () =>
      Effect.gen(function* () {
        const { request } = yield* platform;
        expect(yield* request("upgrade", "v4")).toEqual({
          before: { accepted_at_ms: 123, status: 201, body: '{"data":"capture"}' },
          after: { accepted_at_ms: 123, status: 201, body: '{"data":"capture"}' },
          unsafeRetained: false,
        });
      })
  );
});
