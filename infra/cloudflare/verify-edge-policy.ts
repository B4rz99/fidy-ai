/// <reference types="bun-types" />

import { edgeSecurityPolicy } from "./edge-security";

// Includes #225's support/correction boundaries, #35's canonical admission/allowance headers,
// #33's bounded OAuth/MCP ingress, and #1004's browser-only PaymentEnrollment transport policy.
// Includes #27's private weekly Queue/Workflow topology, bounded dead-letter consumer,
// and fail-closed Core configuration; public routing and edge policy are unchanged by #27.
// Includes #28's shared ProactivityDeliveryWorkflow class; its WeeklyDeliveryWorkflow resource
// identity, Queue topology, public routing, and edge rules remain unchanged.
// Includes #29's authenticated recurring report route in the catalog-derived rate-limit prefixes.
// Includes #990's manual OAuth redirect forwarding; authority and edge rules are unchanged.
const expectedEdgePolicyDigest = "03cbe70c3731d87bc06e371b086fe0540c9536dbe807d51fa886c25ebd7ea4cd";
const securityArtifacts = [
  JSON.stringify(edgeSecurityPolicy),
  await Bun.file(new URL("alchemy.run.ts", import.meta.url)).text(),
  await Bun.file(new URL("worker-observability.ts", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/public-worker.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/subscription/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/subscription/runtime.ts", import.meta.url)
  ).text(),
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
