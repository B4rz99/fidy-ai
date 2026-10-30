/// <reference types="bun-types" />

import { edgeSecurityPolicy } from "./edge-security";

const expectedEdgePolicyDigest = "13ad95e1e7abbcd5c72ce8def85622fdc285ae61a560f9ec71709c9a39799693";
const securityArtifacts = [
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/retention.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/cleanup.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/migrations/0004_connection_cleanup.sql", import.meta.url)
  ).text(),

  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/bancolombia-authentication/internal/token-lifecycle.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/bancolombia-authentication/internal/activation.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/activation.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/grant.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/accounts.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/migrations/0003_connection_activation.sql",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/core-http/internal/http.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/web-session/internal/binding.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/web-session/internal/current-user.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/web-session/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/web-session/internal/authentication.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/canonical-admission/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/canonical-admission/internal/protection.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/sql-assertions/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/core/connections/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/canonical-admission/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/categories/internal/canonical-category.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/categories/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/quotas/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/web-session/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/web-session/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/access-tier/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/identity/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/subscription/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/mcp/native-confirmation.ts", import.meta.url)
  ).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/mcp/runtime.ts", import.meta.url)).text(),
  JSON.stringify(edgeSecurityPolicy),
  await Bun.file(new URL("alchemy.run.ts", import.meta.url)).text(),
  await Bun.file(new URL("worker-observability.ts", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/public-worker.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/bancolombia-authentication/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/bancolombia-authentication/operations.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/bancolombia-authentication/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/src/shell/outbound-http/internal/bancolombia-http.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/outbound-http/internal/transport.ts", import.meta.url)
  ).text(),

  await Bun.file(
    new URL("../../apps/server/cloudflare/release-smoke-worker.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/release-smoke/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/release-smoke/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/release-smoke/runtime.ts", import.meta.url)
  ).text(),
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
    new URL("../../apps/server/cloudflare/bancolombia-sandbox/contract.ts", import.meta.url)
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
  await Bun.file(new URL("../../apps/server/cloudflare/core-worker.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/transactions/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/transactions/internal/recovery-alarm.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/publication-wake.ts", import.meta.url)
  ).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/agent/contract.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/agent/internal/service.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/connections/internal/institution-registration.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/initiation.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/browser.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/authorization.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/erasure.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/migrations/0002_connection_authorization.sql",
      import.meta.url
    )
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
  await Bun.file(new URL("../../apps/site/cloudflare/worker.ts", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/site/scripts/build-headers.ts", import.meta.url)).text(),
];

export const edgePolicyDigest = securityArtifacts
  .reduce(
    (hasher, artifact) => hasher.update(`${artifact.length}:`).update(artifact),
    new Bun.CryptoHasher("sha256")
  )
  .digest("hex");

export const edgePolicyIsReviewed = edgePolicyDigest === expectedEdgePolicyDigest;

if (import.meta.main && !edgePolicyIsReviewed) {
  await Bun.write(Bun.stderr, "Desired edge policy differs from the reviewed manifest.\n");
  process.exitCode = 1;
}
