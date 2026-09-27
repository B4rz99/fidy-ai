import { Miniflare } from "miniflare";
import type * as CoreWorkerModule from "./core-worker";

const coreBundle = new URL("../node_modules/.cache/browser-acceptance-core.mjs", import.meta.url);
const compiled = Bun.spawnSync([
  "bunx",
  "esbuild",
  new URL("./core-worker.ts", import.meta.url).pathname,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--packages=external",
  `--alias:cloudflare:workers=${new URL("./workflow-test-runtime.ts", import.meta.url).pathname}`,
  `--outfile=${coreBundle.pathname}`,
  `--tsconfig=${new URL("../tsconfig.json", import.meta.url).pathname}`,
]);
if (compiled.exitCode !== 0) {
  throw new Error(`Core acceptance fixture failed to compile: ${compiled.stderr.toString()}`);
}
const isCoreWorkerModule = (candidate: unknown): candidate is typeof CoreWorkerModule =>
  typeof candidate === "object" &&
  candidate !== null &&
  "makeCoreWorker" in candidate &&
  typeof candidate.makeCoreWorker === "function";
const coreModule: unknown = await import(coreBundle.href);
if (!isCoreWorkerModule(coreModule)) throw new Error("Core acceptance bundle has no Worker");
const { makeCoreWorker } = coreModule;
const { makePublicWorker } = await import("./public-worker");
const { makeWorkerTelemetry } = await import("./runtime/telemetry");
const { browserOrigins } = await import("./runtime/topology");
const { approvedWorkersAiModel } = await import("@fidy/server/hosted-inference-model");

const certificate = Bun.env.PLAYWRIGHT_TLS_CERT;
const key = Bun.env.PLAYWRIGHT_TLS_KEY;
if (certificate === undefined || key === undefined) {
  throw new Error("Browser acceptance requires TLS certificate and key");
}

const miniflare = new Miniflare({
  workers: [
    {
      config: {
        compatibilityDate: "2026-09-08",
        env: { DB: { id: "browser-acceptance", type: "d1" } },
        manifest: {
          mainModule: "index.mjs",
          modules: {
            "index.mjs": {
              contents: "export default {fetch() {return new Response('ok')}}",
              type: "esm",
            },
          },
        },
        name: "browser-acceptance",
        type: "worker",
      },
    },
  ],
});
await miniflare.ready;
const db = await miniflare.getD1Database("DB");
const migrations = [
  "0003_pending_consent",
  "0004_onboarding_email",
  "0005_verified_onboarding",
  "0006_browser_login",
  "0007_browser_pairing_email",
  "0008_support_recovery",
  "0009_email_replacement",
];
const applyMigration = (name: string): Promise<void> =>
  Bun.file(new URL(`./migrations/${name}.sql`, import.meta.url))
    .text()
    .then((sql) =>
      sql
        .replace(/^--.*$/gmu, "")
        .trim()
        .split(/;\s*\n(?=CREATE |ALTER |$)/u)
        .reduce<Promise<void>>(
          (previous, statement) =>
            previous.then(() => db.prepare(statement).run()).then(() => undefined),
          Promise.resolve()
        )
    );
await migrations.reduce<Promise<void>>(
  (previous, name) => previous.then(() => applyMigration(name)),
  Promise.resolve()
);

const telemetry = makeWorkerTelemetry(() => undefined);
const core = makeCoreWorker(telemetry);
const worker = makePublicWorker(telemetry);
const admissionKeyLength = 32;
const digestHexLength = 64;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4174,
  tls: { cert: Bun.file(certificate), key: Bun.file(key) },
  fetch: (request) =>
    worker.fetch(request, {
      RELEASE_GIT_SHA: "browser-acceptance",
      BROWSER_ORIGIN: browserOrigins.acceptance,
      LOCAL_CANONICAL_READ_BEARER: "",
      PAT_ADMISSION_KEY: "a".repeat(admissionKeyLength),
      CORE: {
        fetch: (forwarded) =>
          core.fetch(new Request(forwarded), {
            DB: db,
            AI: { run: () => Promise.reject(new Error("unused")) },
            CONTRACT_DIGEST: "a".repeat(digestHexLength),
            RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
            HOSTED_AI_MODEL: approvedWorkersAiModel,
            BROWSER_ORIGIN: browserOrigins.acceptance,
            WOMPI_ENVIRONMENT: "",
            WOMPI_PUBLIC_KEY: "",
            WOMPI_PRIVATE_KEY: "",
            WOMPI_INTEGRITY_SECRET: "",
            USER_TRANSACTION_COORDINATOR: {
              getByName: (): Pick<Fetcher, "fetch"> => ({
                fetch: () => Promise.reject(new Error("unused")),
              }),
            },
            KAPSO_API_KEY: "",
            KAPSO_WEBHOOK_SECRET: "",
            CLOUDFLARE_ACCESS_ISSUER: "",
            CLOUDFLARE_ACCESS_AUDIENCE: "",
            WHATSAPP_BUSINESS_PORTFOLIO_ID: "",
          }),
      },
    }),
});

process.stdout.write(`Browser API ingress listening at ${server.url}\n`);
