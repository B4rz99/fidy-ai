#!/usr/bin/env bun

import { currentDisclosureFor } from "@fidy/server/consent-operations";

const webRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const policy = await Bun.file(
  `${webRoot}/src/features/public-site/legal/policy.html`
).arrayBuffer();
const actualDigest = new Bun.CryptoHasher("sha256").update(policy).digest("hex");

const policyDigest = currentDisclosureFor().policy.contentSha256;
if (policyDigest !== actualDigest) {
  throw new Error(
    `Policy digest mismatch: web artifact is ${actualDigest}, server metadata is ${policyDigest}`
  );
}

process.stdout.write(`policy integrity clean: ${actualDigest}\n`);
