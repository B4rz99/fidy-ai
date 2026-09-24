/// <reference types="bun-types" />

import { edgeSecurityPolicy } from "./edge-security";

const expectedEdgePolicyDigest = "d166fb32311f52630c70909f90fada10c4185dab1f6eeef4ee7733f7c4c32d35";
const securityArtifacts = [
  JSON.stringify(edgeSecurityPolicy),
  await Bun.file(new URL("alchemy.run.ts", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/public-worker.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/topology.ts", import.meta.url)
  ).text(),
  await Bun.file(new URL("../../apps/web/cloudflare/production/_headers", import.meta.url)).text(),
];

/** Digest of the complete desired edge, Worker, topology, and static-response policy. */
export const edgePolicyDigest = securityArtifacts
  .reduce(
    (hasher, artifact) => hasher.update(`${artifact.length}:`).update(artifact),
    new Bun.CryptoHasher("sha256")
  )
  .digest("hex");

/** Whether the complete desired edge policy matches the version approved for promotion. */
export const edgePolicyIsReviewed = edgePolicyDigest === expectedEdgePolicyDigest;

if (import.meta.main && !edgePolicyIsReviewed) {
  await Bun.write(Bun.stderr, "Desired edge policy differs from the reviewed manifest.\n");
  process.exitCode = 1;
}
