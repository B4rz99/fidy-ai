import { openAiTestKey } from "../openai.test-fixture";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import handler from "./openai-conformance-worker";
import type { OpenAiEnvironment } from "./contract";

it.effect("reports only the failed conformance check and closed error category", () =>
  Effect.gen(function* () {
    const environment: OpenAiEnvironment = {
      HOSTED_AI_MODEL: "gpt-6-luna",
      OPENAI_API_KEY: openAiTestKey({ run: () => Promise.resolve(Response.json({ choices: [] })) }),
    };
    const response = yield* Effect.tryPromise({
      try: () =>
        handler.fetch(new Request("http://localhost/conformance", { method: "POST" }), environment),
      catch: () => "worker_failure" as const,
    });

    expect(response.status).toBe(503);
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => "invalid_response" as const,
    });
    expect(body).toEqual({
      modelApprovalRevision: "openai-gpt-6-luna-v1",
      outcome: "non_conforming",
      check: "canonical_recurring_read",
      category: "InvalidOutput",
    });
  })
);

it.live("reaches the OpenAI HTTP boundary from native workerd without following redirects", () =>
  Effect.gen(function* () {
    const { build } = yield* Effect.tryPromise(() => import("esbuild"));
    const { Miniflare, Response: NativeResponse } = yield* Effect.tryPromise(
      () => import("miniflare")
    );
    const built = yield* Effect.tryPromise(() =>
      build({
        entryPoints: [new URL("./openai-conformance-worker.ts", import.meta.url).pathname],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        external: ["cloudflare:workers", "node:*"],
      })
    );
    let calls = 0;
    let redirect = false;
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Miniflare({
            workers: [
              {
                config: {
                  name: "openai-native-boundary",
                  type: "worker",
                  compatibilityDate: "2026-09-08",
                  compatibilityFlags: ["nodejs_compat"],
                  env: {
                    OPENAI_API_KEY: { type: "text", value: "synthetic-native-key" },
                    HOSTED_AI_MODEL: { type: "text", value: "gpt-6-luna" },
                  },
                  manifest: {
                    mainModule: "index.mjs",
                    modules: {
                      "index.mjs": { type: "esm", contents: built.outputFiles[0]?.text ?? "" },
                    },
                  },
                },
                dev: {
                  outboundService: {
                    type: "fetcher",
                    handler: (request): InstanceType<typeof NativeResponse> => {
                      calls += 1;
                      expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
                      expect(request.headers.get("authorization")).toBe(
                        "Bearer synthetic-native-key"
                      );
                      return redirect
                        ? new NativeResponse(null, {
                            status: 302,
                            headers: { location: "https://untrusted.invalid/" },
                          })
                        : NativeResponse.json({ choices: [] });
                    },
                  },
                },
              },
            ],
          })
      ),
      (runtime) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
    );
    const response = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("http://localhost/conformance", { method: "POST" })
    );
    const body = yield* Effect.tryPromise(() => response.json());
    expect(calls).toBe(1);
    expect(body).toMatchObject({ check: "canonical_recurring_read", category: "InvalidOutput" });
    calls = 0;
    redirect = true;
    const refused = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("http://localhost/conformance", { method: "POST" })
    );
    expect(yield* Effect.tryPromise(() => refused.json())).toMatchObject({
      category: "ProviderUnavailable",
    });
    expect(calls).toBe(1);
  })
);
