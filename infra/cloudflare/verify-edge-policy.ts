/// <reference types="bun-types" />

import { edgeSecurityPolicy } from "./edge-security";

const expectedEdgePolicyDigest = "3f1915d1b5b8a0e87203299ee37ea653e37b81e1406f18dab330f3a5c01316c5";
const securityArtifacts = [
  JSON.stringify(edgeSecurityPolicy),
  await Bun.file(new URL("alchemy.run.ts", import.meta.url)).text(),
  await Bun.file(new URL("worker-observability.ts", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/public-worker.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/anonymous-admission/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/anonymous-admission/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/operations.ts", import.meta.url)
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
