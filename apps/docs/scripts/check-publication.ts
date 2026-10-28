import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Schema } from "effect";

const distribution = new URL("../dist/", import.meta.url);
const files = readdirSync(distribution, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => resolve(entry.parentPath, entry.name))
  .sort();
const digest = createHash("sha256");
for (const file of files) {
  digest.update(file.slice(distribution.pathname.length));
  digest.update("\0");
  digest.update(readFileSync(file));
  digest.update("\0");
}
const artifactDigest = digest.digest("hex");
const RequiredText = Schema.String.check(Schema.isMinLength(1));
const PublicationEvidence = Schema.Struct({
  artifactDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  productionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  verifiedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  ),
  clients: Schema.Struct({ claudeCode: RequiredText, codex: RequiredText, cli: RequiredText }),
  journeys: Schema.Struct({
    connect: Schema.Literal(true),
    recordCorrect: Schema.Literal(true),
    query: Schema.Literal(true),
  }),
  evidence: RequiredText,
});
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--inspect") {
  process.stdout.write(`${JSON.stringify({ artifactDigest }, undefined, 2)}\n`);
} else {
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--evidence")) {
    throw new Error("Usage: check-publication.ts [--inspect | --evidence FILE]");
  }
  const path = args[1] ?? process.env.DOCS_VERIFICATION_FILE;
  if (!path || !existsSync(path)) {
    throw new Error("Production journey evidence is required before public docs publication");
  }
  const evidence = Schema.decodeUnknownSync(Schema.fromJsonString(PublicationEvidence))(
    readFileSync(path, "utf8")
  );
  if (evidence.artifactDigest !== artifactDigest) {
    throw new Error("Journey evidence does not match this documentation artifact");
  }
  if (files.length === 0 || !existsSync(new URL("index.html", distribution))) {
    throw new Error("Missing docs artifact");
  }
  process.stdout.write(
    "Manual Production journey attestation matches the docs artifact. No live journey was executed by this check.\n"
  );
}
