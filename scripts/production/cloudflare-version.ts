#!/usr/bin/env bun

import { appendFile } from "node:fs/promises";

const versionLine =
  /^Worker Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*$/gmu;

/** Extracts the single immutable Worker version identity reported by Wrangler's upload command. */
export const uploadedVersionId = (output: string): string => {
  const matches = Array.from(output.matchAll(versionLine));
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error("Wrangler output must contain exactly one Worker version ID");
  }
  return matches[0][1];
};

const requiredEnvironment = (name: string): string => {
  const value = Bun.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

if (import.meta.main) {
  const versionId = uploadedVersionId(requiredEnvironment("WRANGLER_OUTPUT"));
  await appendFile(requiredEnvironment("GITHUB_OUTPUT"), `version-id=${versionId}\n`);
}
