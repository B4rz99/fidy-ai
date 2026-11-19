// Disposable production Workers and the pinned release's private Google provider, without an account transport.
import { Effect } from "effect";
import { Miniflare, type MiniflareWorkerConfig } from "miniflare";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import {
  nativeOwnerBindings,
  nativeOwners,
  workerManifest,
} from "../../../apps/server/cloudflare/user-store.test-fixture";

const text = (value: string): { type: "text"; value: string } => ({ type: "text", value });
const observedManifest = async (
  module: string,
  name: string
): Promise<NonNullable<MiniflareWorkerConfig["manifest"]>> => {
  const manifest = await Effect.runPromise(workerManifest(module));
  if (name === "closed-provider") return manifest;
  const wrapper = `import worker from "./production.mjs";
  export * from "./production.mjs";
  export default {...worker,async fetch(request,env,ctx){
    const result=await worker.fetch(request,env,ctx);
    const headers=new Headers(result.headers);
    headers.set("x-rehearsal-${name}",JSON.stringify({tls:new URL(request.url).protocol==="https:",host:new URL(request.url).hostname,forwardedHost:request.headers.has("x-forwarded-host"),signed:request.headers.has("x-fidy-acceptance-proof"),isolation:result.headers.has("x-fidy-recovery-isolation")}));
    return new Response(result.body,{status:result.status,headers});
  }};`;
  return {
    mainModule: "index.mjs",
    modules: {
      "index.mjs": { type: "esm", contents: wrapper },
      "production.mjs": manifest.modules["index.mjs"],
    },
  };
};
const worker = async (
  name: string,
  module: string,
  { env, exports = {} }: Pick<MiniflareWorkerConfig, "env" | "exports">
): Promise<{ config: MiniflareWorkerConfig }> => ({
  config: {
    name,
    type: "worker",
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
    exports,
    env,
    manifest: await observedManifest(module, name),
  },
});
export const closedRuntime = async (revision: string, secret: string): Promise<Miniflare> => {
  const api = installedOrigins.acceptance;
  const derive = (purpose: string): string =>
    new Bun.CryptoHasher("sha256", secret).update(revision + "/" + purpose).digest("hex");
  const digestWidth = 64;
  const shared = {
    RELEASE_GIT_SHA: text(revision),
    RECOVERY_ISOLATION: text("isolated"),
    NATIVE_STORAGE_ADMISSION: text("closed"),
    BROWSER_ORIGIN: text(api.browser),
    SMOKE_PROOF: text(secret),
    CONTRACT_DIGEST: text("a".repeat(digestWidth)),
    CF_VERSION_METADATA: { type: "version-metadata" as const },
    RELEASE_FIXTURE: { type: "worker" as const, worker: "closed-provider" },
    SMOKE_BUCKET: { type: "r2" as const, name: "private-receipt-rehearsal" },
  };
  return new Miniflare({
    handleStructuredLogs: () => undefined,
    workers: await Promise.all([
      worker("ingress", "./public-worker.ts", {
        env: {
          ...shared,
          CORE: { type: "worker", worker: "core" },
          PAT_ADMISSION_KEY: text(derive("pat-admission")),
        },
      }),
      worker("core", "./core-worker.ts", {
        env: {
          ...shared,
          ...nativeOwnerBindings,
          NATIVE_FIXTURE_SIGNING_KEY: text(process.env.TEST_FIXTURE_PRIVATE_KEY ?? ""),
          SQLITE_STORE_CAPACITY_BYTES: text("1000000000"),
          GOOGLE_CLIENT_ID: text("fidy-native-google"),
          GOOGLE_CLIENT_SECRET: text(derive("google")),
          GOOGLE_REDIRECT_URI: text(api.api + "/providers/google/callback"),
          MICROSOFT_CLIENT_ID: text("fidy-native-microsoft"),
          MICROSOFT_CLIENT_SECRET: text(derive("microsoft")),
          MICROSOFT_REDIRECT_URI: text(api.api + "/providers/microsoft/callback"),
          RESEND_API_KEY: text(derive("resend")),
        },
        exports: nativeOwners,
      }),
      worker("closed-provider", "./release-smoke-worker.ts", {
        env: {
          ...shared,
          ACCEPTANCE_CODE_KEY: text(derive("oidc-code")),
          ACCEPTANCE_GOOGLE_SECRET: text(derive("google")),
          ACCEPTANCE_MICROSOFT_SECRET: text(derive("microsoft")),
          ACCEPTANCE_API_ORIGIN: text(api.api),
        },
      }),
    ]),
  });
};
