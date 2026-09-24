import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import handler from "./workers-ai-conformance-worker";
import type { WorkersAiEnvironment } from "./workers-ai";

it.effect("reports only the failed conformance check and closed error category", () =>
  Effect.gen(function* () {
    const environment: WorkersAiEnvironment = {
      HOSTED_AI_MODEL: "@cf/google/gemma-4-26b-a4b-it",
      AI: { run: () => Promise.resolve(Response.json({ choices: [] })) },
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
      modelApprovalRevision: "workers-ai-gemma-4-2026-09-22",
      outcome: "non_conforming",
      check: "canonical_query",
      category: "InvalidOutput",
    });
  })
);
