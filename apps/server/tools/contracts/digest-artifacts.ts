#!/usr/bin/env bun

import { Effect } from "effect";
import { contractArtifactsFrom, contractDigest } from "./artifacts";

const main = Effect.gen(function* () {
  const [openApiPath, operationPolicyPath] = Bun.argv.slice(2);
  if (openApiPath === undefined || operationPolicyPath === undefined) {
    throw new Error("Usage: digest-artifacts.ts <openapi.json> <operation-policy.json>");
  }
  const openapi: unknown = yield* Effect.tryPromise(() => Bun.file(openApiPath).json());
  const policy: unknown = yield* Effect.tryPromise(() => Bun.file(operationPolicyPath).json());
  process.stdout.write(`${contractDigest(contractArtifactsFrom(openapi, policy, "preview"))}\n`);
});

if (import.meta.main) await Effect.runPromise(main);
