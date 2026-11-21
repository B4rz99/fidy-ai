import { fileURLToPath } from "node:url";
import type { PerformanceMember } from "../../../apps/server/cloudflare/release-isolation/contract";
import { serveFixture } from "./bridge";
import { Config, Effect, Redacted } from "effect";
import { Miniflare, type MiniflareWorkerConfig } from "miniflare";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import {
  nativeOwnerBindings,
  nativeOwners,
  workerManifest,
} from "../../../apps/server/cloudflare/user-store.test-fixture";

type TextBinding = { type: "text"; value: string };

const text = (value: string): TextBinding => ({ type: "text", value });

type OptionalCoreBindings = Partial<
  Record<"NATIVE_FIXTURE_SIGNING_KEY" | "NATIVE_FIXTURE_MEMBER", TextBinding>
>;

const optionalCoreBindings = (
  baseline: boolean,
  privateKey: string,
  member: string
): OptionalCoreBindings => {
  const bindings: OptionalCoreBindings = {};

  if (!baseline) bindings.NATIVE_FIXTURE_SIGNING_KEY = text(privateKey);

  if (member === "performance-2") bindings.NATIVE_FIXTURE_MEMBER = text(member);

  return bindings;
};

const meterModule = Effect.tryPromise(() =>
  Bun.build({
    entrypoints: [fileURLToPath(new URL("./meter.test-fixture.mjs", import.meta.url))],
    format: "esm",
    target: "browser",
    throw: true,
  })
).pipe(
  Effect.flatMap(({ outputs: [meter] }) =>
    meter === undefined
      ? Effect.fail(Error("Native meter bundle is empty"))
      : Effect.tryPromise(() => meter.text())
  )
);

const meteredManifest = Effect.fnUntraced(function* (module: string, name: string) {
  const manifest = yield* workerManifest(module);

  const wrapOwners =
    name === "core"
      ? Object.keys(nativeOwners)
          .map(
            (owner) =>
              "export const " +
              owner +
              "=observed(" +
              JSON.stringify(owner) +
              ",Production." +
              owner +
              ");"
          )
          .join("\n")
      : "";

  const mapping =
    name === "ingress"
      ? 'const url=new URL(request.url);if(url.hostname!=="127.0.0.1")return new Response(null,{status:403});request=new Request("' +
        installedOrigins.acceptance.api +
        '"+url.pathname+url.search,request);'
      : "";

  const wrapper =
    'import * as Production from "./production.mjs"; import {observed,observedBindings,totals,buckets} from "./meter.mjs"; export * from "./production.mjs";' +
    wrapOwners +
    'export default {...Production.default,fetch(request,env,ctx){if(request.url==="https://offline.invalid/native-row-counts")return totals();if(request.url==="https://offline.invalid/r2-counts")return buckets();' +
    mapping +
    "return Production.default.fetch(request,observedBindings(env),ctx);}," +
    (name === "core"
      ? "scheduled(controller,env){return Production.default.scheduled(controller,observedBindings(env));}"
      : "") +
    "};";

  return {
    mainModule: "index.mjs",
    modules: {
      "index.mjs": { type: "esm" as const, contents: wrapper },
      "production.mjs": manifest.modules["index.mjs"],
      "meter.mjs": {
        type: "esm" as const,
        contents: yield* meterModule,
      },
    },
  };
});

const observedManifest = Effect.fnUntraced(function* (module: string, name: string) {
  if (yield* Config.Boolean("FIDY_BROWSER_METER").pipe(Config.withDefault(false))) {
    return yield* meteredManifest(module, name);
  }

  const manifest = yield* workerManifest(module);

  if (name !== "ingress") return manifest;

  const entrypoints = new Bun.Transpiler({ loader: "js" }).scan(
    manifest.modules["index.mjs"].contents
  ).exports;

  if (entrypoints.toSorted().join(",") !== "default,makePublicWorker") {
    return yield* Effect.fail(
      Error("Ingress bundle differs from the captured public export inventory")
    );
  }

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

const fixtureGeneration = Effect.fnUntraced(function* (revision: string) {
  const baseline = yield* Config.Boolean("FIDY_REHEARSAL_BASELINE").pipe(Config.withDefault(false));
  const fallback = yield* Config.Boolean("FIDY_REHEARSAL_FALLBACK").pipe(Config.withDefault(false));

  const entry = (name: string): string =>
    (baseline ? "../../../closed-baseline/apps/server/cloudflare/" : "./") + name + ".ts";

  const providerRevision = yield* Config.String("FIDY_NATIVE_FIXTURE_PROVIDER_REVISION").pipe(
    Config.withDefault(revision)
  );

  const providerEntry =
    providerRevision === revision
      ? entry("release-smoke-worker")
      : "../../../closed-baseline/apps/server/cloudflare/release-smoke-worker.ts";

  return {
    baseline,
    ingressEntry: entry(fallback ? "fixture-fallback-ingress" : "public-worker"),
    coreEntry: entry(fallback ? "fixture-fallback-core" : "core-worker"),
    providerEntry,
    providerRevision,
  };
});

export const closedRuntime = Effect.fnUntraced(function* (
  { revision, secret }: { revision: string; secret: string },
  directory: string = "",
  member: PerformanceMember = "performance-1"
) {
  const privateKey = Redacted.value(yield* Config.Redacted("TEST_FIXTURE_PRIVATE_KEY"));

  const { baseline, ingressEntry, coreEntry, providerEntry, providerRevision } =
    yield* fixtureGeneration(revision);

  const providerRevisionBinding: Partial<Record<"ACCEPTANCE_PROVIDER_REVISION", TextBinding>> =
    providerRevision === revision ? {} : { ACCEPTANCE_PROVIDER_REVISION: text(providerRevision) };

  const shared = { ...sharedBindings(revision, secret), ...providerRevisionBinding };

  const persistence: Partial<Record<"resourcePersistencePath", string>> =
    directory === "" ? {} : { resourcePersistencePath: directory };

  return new Miniflare({
    ...persistence,
    handleStructuredLogs: (): void => undefined,
    workers: yield* Effect.all([
      worker("ingress", ingressEntry, {
        env: {
          ...shared,
          CORE: { type: "worker", worker: "core" },
          PAT_ADMISSION_KEY: text(deriveSecret(secret, revision, "pat-admission")),
        },
      }),
      worker("core", coreEntry, {
        env: {
          ...shared,
          ...nativeOwnerBindings,
          EMAIL_BUCKET: { type: "r2", name: "private-email" },
          STATEMENT_STAGING_BUCKET: { type: "r2", name: "private-statements" },
          SAMPLE_BUCKET: { type: "r2", name: "private-samples" },
          ...optionalCoreBindings(baseline, privateKey, member),
          SQLITE_STORE_CAPACITY_BYTES: text("1000000000"),
          GOOGLE_CLIENT_ID: text("fidy-native-google"),
          GOOGLE_CLIENT_SECRET: text(deriveSecret(secret, providerRevision, "google")),
          GOOGLE_REDIRECT_URI: text(api.api + "/providers/google/callback"),
          MICROSOFT_CLIENT_ID: text("fidy-native-microsoft"),
          MICROSOFT_CLIENT_SECRET: text(deriveSecret(secret, providerRevision, "microsoft")),
          MICROSOFT_REDIRECT_URI: text(api.api + "/providers/microsoft/callback"),
          RESEND_API_KEY: text(deriveSecret(secret, revision, "resend")),
        },
        exports: nativeOwners,
      }),
      worker("closed-provider", providerEntry, {
        env: {
          ...shared,
          RELEASE_GIT_SHA: text(providerRevision),
          ACCEPTANCE_CODE_KEY: text(deriveSecret(secret, providerRevision, "oidc-code")),
          ACCEPTANCE_GOOGLE_SECRET: text(deriveSecret(secret, providerRevision, "google")),
          ACCEPTANCE_MICROSOFT_SECRET: text(deriveSecret(secret, providerRevision, "microsoft")),
          ACCEPTANCE_API_ORIGIN: text(api.api),
        },
      }),
    ]),
  });
});

const run = Effect.gen(function* () {
  const revision = yield* Config.String("FIDY_NATIVE_REVISION");
  const secret = Redacted.value(yield* Config.Redacted("SMOKE_PROOF"));

  const member = yield* Config.Literals(
    ["performance-1", "performance-2"],
    "FIDY_BOUND_FIXTURE_MEMBER"
  ).pipe(Config.withDefault("performance-1"));

  yield* Effect.acquireUseRelease(
    closedRuntime({ revision, secret }, "", member),
    (runtime) => serveFixture(runtime, member),
    (runtime) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
  );
});

if (import.meta.main) {
  await Effect.runPromise(run).catch(() => {
    process.stderr.write("Closed workerd rehearsal stopped\n");
    process.exitCode = 1;
  });
}
