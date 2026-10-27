/// <reference types="bun-types" />

import { edgeSecurityPolicy } from "./edge-security";

const expectedEdgePolicyDigest = "4710fe5fed5567346d8bdae9a3988592d9b554f77dd3397229921fbdca7ecb40";
const securityArtifacts = [
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
