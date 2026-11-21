#!/usr/bin/env bun

import { Data, Effect } from "effect";
import { contractArtifactsFrom, contractDigest } from "./artifacts";

class DigestUsageError extends Data.TaggedError("DigestUsageError")<{
  readonly message: string;
}> {}

const main = Effect.gen(function* () {
  const [openApiPath, operationPolicyPath] = Bun.argv.slice(2);

  if (openApiPath === undefined || operationPolicyPath === undefined) {
    return yield* new DigestUsageError({
      message: "Usage: digest-artifacts.ts <openapi.json> <operation-policy.json>",
    });
  }

  const openapi: unknown = yield* Effect.tryPromise(() => Bun.file(openApiPath).json());
  const policy: unknown = yield* Effect.tryPromise(() => Bun.file(operationPolicyPath).json());
  process.stdout.write(
    `${contractDigest(contractArtifactsFrom({ openapi, policy, subject: "preview" }))}\n`
  );
});

if (import.meta.main) await Effect.runPromise(main);
