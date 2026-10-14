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
// Includes #236's authenticated canonical Subscription cancellation route in the catalog-derived rate limit.
// Includes #304's catalog-derived /institutions and /connections rate-limit routes.
// Includes #305's same-User browser Connection review/preparation routes and edge rate limits.
// Includes Connections-owned browser transport recognition and cookie-only forwarding policy.
// Includes #1086 provider callbacks, anonymous provider admission, and removal of email signup resources.
// Includes #305's static sandbox JWKS and fail-closed registration callback without Core authority.
// Includes #1086's incident-only isolated public/Core admission and gated recovery uploads.
// Includes #1086's query-redacted diagnostic logs; invocation records remain disabled.
// Includes #1086's path-scoped recovery Access application, sole-email operator group,
// email PIN identity provider, and application-derived Core audience.
// Includes #1091's provider-entry popup isolation exceptions; authenticated documents remain strict.
// Public marketing GET/HEAD only: skip BIC/UA signatures; preserve managed WAF, DDoS and private-route controls.
// Includes #1139's type-only Proactivity health binding declarations in the hashed runtime contract.
// #1139 adds no change to the merged public marketing policy, topology, routing, or security settings.
// #1168 reuses the existing private namespace for maintenance, restoring the original reviewed topology.
// Includes #1182's public installer GET/HEAD routes and bounded public CLI version metadata.
// Includes #1247 MCP ingress authority and #1250 provider admission and persistent HTTPS.
// Includes #1257 browser session binding bootstrap and forwarding.
// Includes #1255 native outbound response ownership; destinations, credentials, routing and edge rules are unchanged.
// Includes #1260 bounded, lossy Core refusal telemetry after response admission; no routing, edge or authority change.
// Selective telemetry creates isolated public roots and trusted private trace propagation;
// credential admission, routing, topology and platform invocation-log policy stay unchanged.
// #1262 expands refusal observation to exact callback and MCP boundaries; authority and edge rules are unchanged.
// Public Astro site owns the apex; app legal/feature redirects and installer handoffs are static.
// Both static response policies and the Astro CSP configuration are covered by this manifest.
// #1291 wires existing Proactivity configuration with disabled defaults; routing and authority are unchanged.
// Includes #1273 cookie-only Processing Consent controls, declaration-derived edge path limits,
// and no new public database binding, external provider authority or production bank access.
const expectedEdgePolicyDigest = "1e1ea39dc32f1abeb8eef6e29aace3e097d182bb16d052c660204a27a23c6a52";
const securityArtifacts = [
  JSON.stringify(edgeSecurityPolicy),
  await Bun.file(new URL("alchemy.run.ts", import.meta.url)).text(),
  await Bun.file(new URL("worker-observability.ts", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/public-worker.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/release-isolation/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/core-http/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/outbound-http/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/bancolombia-sandbox/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/bancolombia-sandbox/internal/public-key.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/processing-consent/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/processing-consent/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/connections/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/connections/runtime.ts", import.meta.url)
  ).text(),
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
  await Bun.file(
    new URL("../../apps/web/cloudflare/production/_redirects", import.meta.url)
  ).text(),
  await Bun.file(new URL("../../apps/site/public/_headers", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/site/public/_redirects", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/site/astro.config.ts", import.meta.url)).text(),
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
