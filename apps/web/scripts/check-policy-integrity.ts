#!/usr/bin/env bun

const webRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const policy = await Bun.file(`${webRoot}/src/policy/policy.html`).arrayBuffer();
const actualDigest = new Bun.CryptoHasher("sha256").update(policy).digest("hex");

const disclosurePath = new URL(
  "../../server/src/shell/consent/current-disclosure.ts",
  import.meta.url
);
const disclosureSource = await Bun.file(disclosurePath).text();
const policyMetadata = /policy:\s*\{[\s\S]*?contentSha256:\s*"([a-f0-9]{64})"/u.exec(
  disclosureSource
);
if (policyMetadata === null) {
  throw new Error("Could not find server disclosure policy digest metadata");
}
if (policyMetadata[1] !== actualDigest) {
  throw new Error(
    `Policy digest mismatch: web artifact is ${actualDigest}, server metadata is ${policyMetadata[1]}`
  );
}

process.stdout.write(`policy integrity clean: ${actualDigest}\n`);
