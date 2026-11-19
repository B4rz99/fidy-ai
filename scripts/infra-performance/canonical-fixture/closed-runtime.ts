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
export const closedRuntime = async (revision: string, secret: string): Promise<Miniflare> => {
  const api = installedOrigins.acceptance;
  const derive = (purpose: string): string =>
    new Bun.CryptoHasher("sha256", secret).update(revision + "/" + purpose).digest("hex");
  const shared = {
    RELEASE_GIT_SHA: text(revision),
    RECOVERY_ISOLATION: text("isolated"),
    NATIVE_STORAGE_ADMISSION: text("closed"),
    BROWSER_ORIGIN: text(api.browser),
    SMOKE_PROOF: text(secret),
    CONTRACT_DIGEST: text("a".repeat(64)),
    CF_VERSION_METADATA: { type: "version-metadata" as const },
    RELEASE_FIXTURE: { type: "worker" as const, worker: "closed-provider" },
    SMOKE_BUCKET: { type: "r2" as const, name: "private-receipt-rehearsal" },
  };
  const worker = async (
    name: string,
    module: string,
    env: MiniflareWorkerConfig["env"],
    exports: MiniflareWorkerConfig["exports"] = {}
  ): Promise<{ config: MiniflareWorkerConfig }> => ({
    config: {
      name,
      type: "worker",
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
      exports,
      env,
      manifest: await Effect.runPromise(workerManifest(module)),
    },
  });
  return new Miniflare({
    handleStructuredLogs: () => undefined,
    workers: await Promise.all([
      worker("ingress", "./public-worker.ts", {
        ...shared,
        CORE: { type: "worker", worker: "core" },
        PAT_ADMISSION_KEY: text(derive("pat-admission")),
      }),
      worker(
        "core",
        "./core-worker.ts",
        {
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
        nativeOwners
      ),
      worker("closed-provider", "./release-smoke-worker.ts", {
        ...shared,
        ACCEPTANCE_CODE_KEY: text(derive("oidc-code")),
        ACCEPTANCE_GOOGLE_SECRET: text(derive("google")),
        ACCEPTANCE_MICROSOFT_SECRET: text(derive("microsoft")),
        ACCEPTANCE_API_ORIGIN: text(api.api),
      }),
    ]),
  });
};
