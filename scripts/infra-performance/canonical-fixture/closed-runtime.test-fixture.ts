import { serveFixture } from "./bridge";
// Disposable production Workers and the pinned release's private Google provider, without an account transport.
import { Config, Effect, Redacted } from "effect";
import { Miniflare, type MiniflareWorkerConfig } from "miniflare";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import {
  nativeOwnerBindings,
  nativeOwners,
  workerManifest,
} from "../../../apps/server/cloudflare/user-store.test-fixture";

const text = (value: string): { type: "text"; value: string } => ({ type: "text", value });
const observedManifest = Effect.fnUntraced(function* (module: string, name: string) {
  const manifest = yield* workerManifest(module);
  if (name !== "ingress") return manifest;
  // The local Miniflare entry listener supplies its loopback URL. Preserve the fixed original TLS
  // URL when delivering to the production Ingress so the real signed request can be verified.
  const wrapper = `import worker from "./production.mjs";
    export default { ...worker,fetch(request,env,ctx) {
      const url=new URL(request.url);
      if(url.hostname!=="127.0.0.1") return new Response(null,{status:403});
      return worker.fetch(new Request("${installedOrigins.acceptance.api}"+url.pathname+url.search,request),env,ctx);
    }};`;
  return {
    mainModule: "index.mjs",
    modules: {
      "index.mjs": { type: "esm" as const, contents: wrapper },
      "production.mjs": manifest.modules["index.mjs"],
    },
  };
});
const worker = Effect.fnUntraced(function* (
  name: string,
  module: string,
  { env, exports = {} }: Pick<MiniflareWorkerConfig, "env" | "exports">
) {
  const config: MiniflareWorkerConfig = {
    name,
    type: "worker",
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
    exports,
    env,
    manifest: yield* observedManifest(module, name),
  };
  return { config };
});
const deriveSecret = (secret: string, revision: string, purpose: string): string =>
  new Bun.CryptoHasher("sha256", secret).update(revision + "/" + purpose).digest("hex");
const api = installedOrigins.acceptance;
const digestWidth = 64;
const sharedBindings = (
  revision: string,
  secret: string
): NonNullable<MiniflareWorkerConfig["env"]> => ({
  RELEASE_GIT_SHA: text(revision),
  RECOVERY_ISOLATION: text("isolated"),
  NATIVE_STORAGE_ADMISSION: text("closed"),
  BROWSER_ORIGIN: text(api.browser),
  SMOKE_PROOF: text(secret),
  CONTRACT_DIGEST: text("a".repeat(digestWidth)),
  CF_VERSION_METADATA: { type: "version-metadata" as const },
  RELEASE_FIXTURE: { type: "worker" as const, worker: "closed-provider" },
  SMOKE_BUCKET: { type: "r2" as const, name: "private-receipt-rehearsal" },
});
export const closedRuntime = Effect.fnUntraced(function* (
  { revision, secret }: { revision: string; secret: string },
  directory: string = ""
) {
  const privateKey = Redacted.value(yield* Config.Redacted("TEST_FIXTURE_PRIVATE_KEY"));
  const baseline = yield* Config.Boolean("FIDY_REHEARSAL_BASELINE").pipe(Config.withDefault(false));
  const entry = (name: string): string =>
    (baseline ? "../../../closed-baseline/apps/server/cloudflare/" : "./") + name + ".ts";
  const shared = sharedBindings(revision, secret);
  return new Miniflare({
    ...(directory === "" ? {} : { resourcePersistencePath: directory }),
    handleStructuredLogs: (): void => undefined,
    workers: yield* Effect.all([
      worker("ingress", entry("public-worker"), {
        env: {
          ...shared,
          CORE: { type: "worker", worker: "core" },
          PAT_ADMISSION_KEY: text(deriveSecret(secret, revision, "pat-admission")),
        },
      }),
      worker("core", entry("core-worker"), {
        env: {
          ...shared,
          ...nativeOwnerBindings,
          EMAIL_BUCKET: { type: "r2", name: "private-email" },
          STATEMENT_STAGING_BUCKET: { type: "r2", name: "private-statements" },
          SAMPLE_BUCKET: { type: "r2", name: "private-samples" },
          ...(baseline ? {} : { NATIVE_FIXTURE_SIGNING_KEY: text(privateKey) }),
          SQLITE_STORE_CAPACITY_BYTES: text("1000000000"),
          GOOGLE_CLIENT_ID: text("fidy-native-google"),
          GOOGLE_CLIENT_SECRET: text(deriveSecret(secret, revision, "google")),
          GOOGLE_REDIRECT_URI: text(api.api + "/providers/google/callback"),
          MICROSOFT_CLIENT_ID: text("fidy-native-microsoft"),
          MICROSOFT_CLIENT_SECRET: text(deriveSecret(secret, revision, "microsoft")),
          MICROSOFT_REDIRECT_URI: text(api.api + "/providers/microsoft/callback"),
          RESEND_API_KEY: text(deriveSecret(secret, revision, "resend")),
        },
        exports: nativeOwners,
      }),
      worker("closed-provider", entry("release-smoke-worker"), {
        env: {
          ...shared,
          ACCEPTANCE_CODE_KEY: text(deriveSecret(secret, revision, "oidc-code")),
          ACCEPTANCE_GOOGLE_SECRET: text(deriveSecret(secret, revision, "google")),
          ACCEPTANCE_MICROSOFT_SECRET: text(deriveSecret(secret, revision, "microsoft")),
          ACCEPTANCE_API_ORIGIN: text(api.api),
        },
      }),
    ]),
  });
});
const run = Effect.gen(function* () {
  const revision = yield* Config.String("FIDY_NATIVE_REVISION");
  const secret = Redacted.value(yield* Config.Redacted("SMOKE_PROOF"));
  yield* Effect.acquireUseRelease(closedRuntime({ revision, secret }), serveFixture, (runtime) =>
    Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
  );
});
if (import.meta.main) {
  await Effect.runPromise(run).catch(() => {
    process.stderr.write("Closed workerd rehearsal stopped\n");
    process.exitCode = 1;
  });
}
