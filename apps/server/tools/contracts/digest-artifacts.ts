#!/usr/bin/env bun

import { contractArtifactsFrom, contractDigest } from "./compatibility";

if (import.meta.main) {
  const [openApiPath, operationPolicyPath] = Bun.argv.slice(2);
  if (openApiPath === undefined || operationPolicyPath === undefined) {
    throw new Error("Usage: digest-artifacts.ts <openapi.json> <operation-policy.json>");
  }
  const artifacts = contractArtifactsFrom(
    await Bun.file(openApiPath).json(),
    await Bun.file(operationPolicyPath).json(),
    "preview"
  );
  process.stdout.write(`${contractDigest(artifacts)}\n`);
}
