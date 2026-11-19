// The reusable native signer receives the bound Session on stdin. Only the parent reads its proof.
import { Effect } from "effect";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract.ts";
import { signAcceptanceRequest } from "../../../apps/server/cloudflare/release-isolation/operations.ts";
import { acceptanceLifetimeMs } from "../../../apps/server/cloudflare/release-isolation/contract.ts";

const origins = installedOrigins.acceptance;
const { cookie, binding, revision } = await Bun.stdin.json();
const path = "/transactions?limit=25";
const request = new Request(origins.api + path, { headers: { cookie, origin: origins.browser, "fidy-session-binding": binding } });
const proof = await Effect.runPromise(signAcceptanceRequest({
  environment: {
    BROWSER_ORIGIN: origins.browser, RELEASE_GIT_SHA: revision, SMOKE_PROOF: process.env.SMOKE_PROOF,
    RECOVERY_ISOLATION: "isolated", NATIVE_STORAGE_ADMISSION: "closed",
  },
  request, boundary: "ingress", deadline: Date.now() + acceptanceLifetimeMs,
}));
process.stdout.write(proof);
