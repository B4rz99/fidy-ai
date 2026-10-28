import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

await test("explicit generation publishes agent operations and their reachable schemas, excluding browser authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fidy-docs-reference-"));
  try {
    const source = join(directory, "source.json");
    await writeFile(
      source,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Fidy", version: "1" },
        paths: {
          "/transactions": {
            get: {
              operationId: "transactions.listTransactions",
              description: "List transactions.",
              parameters: [],
              responses: {
                200: {
                  description: "Success",
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Result" } },
                  },
                },
              },
              "x-fidy-access": {
                type: "user-owned-agent-scoped",
                scope: { evaluation: "operation", capability: "read" },
              },
              "x-fidy-agent-confirmation": "not-required",
              "x-fidy-operation-kind": "query",
              "x-fidy-required-tier": "free",
            },
          },
          "/private": {
            post: {
              operationId: "tokens.createPAT",
              "x-fidy-access": { type: "fresh-web-session-only" },
            },
          },
        },
        components: {
          schemas: {
            Result: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    amount: { type: "string" },
                    operation: { enum: ["transactions.listTransactions"] },
                  },
                },
                {
                  type: "object",
                  properties: {
                    operation: { enum: ["tokens.createPAT"] },
                    input: { $ref: "#/components/schemas/Private" },
                  },
                },
              ],
            },
            Private: { type: "string" },
          },
        },
      })
    );
    const result = spawnSync(
      "bun",
      ["apps/docs/scripts/generate-reference.ts", "--source", source, "--destination", directory],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    const published = await readFile(join(directory, "public/reference/openapi.json"), "utf8");
    assert.match(published, /transactions.listTransactions/u);
    assert.doesNotMatch(published, /tokens.createPAT|"Private"|"\/private"/u);
    const page = await readFile(
      join(directory, "src/content/docs/reference/transactions.listTransactions.md"),
      "utf8"
    );
    assert.match(page, /read/u);
    assert.match(page, /200/u);
    assert.match(page, /Result/u);
    const again = spawnSync(
      "bun",
      ["apps/docs/scripts/generate-reference.ts", "--source", source, "--destination", directory],
      { encoding: "utf8" }
    );
    assert.equal(again.status, 0, again.stderr);
    assert.equal(
      await readFile(
        join(directory, "src/content/docs/reference/transactions.listTransactions.md"),
        "utf8"
      ),
      page
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
