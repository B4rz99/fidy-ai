import { Schema } from "effect";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

await test("manual publication refuses missing journey evidence without altering the built site", async () => {
  const before = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const result = spawnSync(
    "bun",
    [
      "apps/docs/scripts/check-publication.ts",
      "--evidence",
      "/nonexistent/fidy-docs-evidence.json",
    ],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Production journey evidence is required/u);
  assert.equal(await readFile(new URL("../dist/index.html", import.meta.url), "utf8"), before);
});

await test("manual publication accepts exact-artifact evidence and rejects incomplete or mismatched evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fidy-docs-publication-"));
  try {
    const inspect = spawnSync("bun", ["apps/docs/scripts/check-publication.ts", "--inspect"], {
      encoding: "utf8",
    });
    assert.equal(inspect.status, 0, inspect.stderr);
    const evidence = {
      ...Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ artifactDigest: Schema.String }))
      )(inspect.stdout),
      productionRevision: "a".repeat("e5073e4ba1b43fdbdf5c1920c59417645b67239c".length),
      verifiedAt: "2026-10-27T20:00:00.000Z",
      clients: { claudeCode: "2.1.289", codex: "0.160.0", cli: "0.1.0" },
      journeys: { connect: true, recordCorrect: true, query: true },
      evidence:
        "Owner verified all documented client paths on Production using a dedicated test account.",
    };
    const path = join(directory, "evidence.json");
    await writeFile(path, JSON.stringify(evidence));
    const invoke = () =>
      spawnSync("bun", ["apps/docs/scripts/check-publication.ts", "--evidence", path], {
        encoding: "utf8",
      });
    const accepted = invoke();
    assert.equal(accepted.status, 0, accepted.stderr);
    await writeFile(
      path,
      JSON.stringify({ ...evidence, journeys: { ...evidence.journeys, recordCorrect: false } })
    );
    assert.notEqual(invoke().status, 0);
    await writeFile(
      path,
      JSON.stringify({ ...evidence, artifactDigest: "0".repeat(evidence.artifactDigest.length) })
    );
    assert.notEqual(invoke().status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
