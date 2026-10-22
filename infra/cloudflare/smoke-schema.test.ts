import { Effect } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Miniflare } from "miniflare";
import { installTestSchema } from "../../apps/server/cloudflare/d1-test-fixture";
import { handleSmoke } from "../../apps/server/cloudflare/runtime/release-smoke/operations";
import {
  SyntheticBindings,
  smokeEnvironment,
  unavailableBucket,
  unavailableQueue,
} from "./incomplete-platform-fixture";

it.effect("refuses a candidate whose protected-read dependencies are absent from existing D1", () =>
  Effect.gen(function* () {
    const mf = new Miniflare({
      workers: [
        {
          config: {
            name: "smoke-schema",
            type: "worker",
            compatibilityDate: "2026-09-08",
            env: { DB: { type: "d1", id: "smoke-schema" } },
            manifest: {
              mainModule: "index.mjs",
              modules: {
                "index.mjs": {
                  contents: "export default {fetch() {return new Response('ok')}}",
                  type: "esm",
                },
              },
            },
          },
        },
      ],
    });
    yield* Effect.addFinalizer(() => Effect.tryPromise(() => mf.dispose()).pipe(Effect.orDie));
    yield* Effect.tryPromise(() => mf.ready);
    const db = yield* Effect.tryPromise(() => mf.getD1Database("DB"));
    yield* Effect.tryPromise(() => installTestSchema({ db }));
    let publications = 0;
    const environment = smokeEnvironment({
      DB: db,
      SMOKE_BUCKET: SyntheticBindings.withMethods(unavailableBucket, {
        put: (): Promise<void> => Promise.resolve(),
        get: (): Promise<object> => Promise.resolve({}),
      }),
      SMOKE_QUEUE: SyntheticBindings.withMethods(unavailableQueue, {
        send: (): Promise<void> => {
          publications++;
          return Promise.resolve();
        },
      }),
      USER_TRANSACTION_COORDINATOR: {
        getByName: (): { fetch: () => Promise<Response> } => ({
          fetch: (): Promise<Response> => Promise.resolve(new Response()),
        }),
      },
    });
    const probe = (id: string): Promise<Response> =>
      handleSmoke({
        environment,
        request: new Request("https://core.internal/internal/release-smoke", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-fidy-smoke-proof": environment.SMOKE_PROOF,
          },
          body: JSON.stringify({
            protocolVersion: 1,
            probeId: id.repeat(32),
            expectedPublicVersionId: environment.CF_VERSION_METADATA.id,
            expectedCoreVersionId: environment.CF_VERSION_METADATA.id,
            expectedGitRevision: environment.RELEASE_GIT_SHA,
            expectedContractDigest: environment.CONTRACT_DIGEST,
          }),
        }),
      });
    expect((yield* Effect.tryPromise(() => probe("a"))).status).toBe(202);
    expect(publications).toBe(1);
    yield* Effect.tryPromise(() => db.prepare("DROP VIEW payment_source_context").run());
    const refused = yield* Effect.tryPromise(() => probe("b"));
    expect(refused.status).toBe(503);
    expect(refused.headers.get("x-fidy-smoke-failure")).toBe("schema");
    expect(publications).toBe(1);
    expect(yield* Effect.tryPromise(() => refused.text())).not.toContain("payment_source_context");
  })
);
