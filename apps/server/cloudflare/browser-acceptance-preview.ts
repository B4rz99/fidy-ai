import { makePublicWorker } from "./public-worker";
import { makeWorkerTelemetry } from "./runtime/telemetry";
import { browserOrigins } from "./runtime/topology";

const certificate = Bun.env.PLAYWRIGHT_TLS_CERT;
const key = Bun.env.PLAYWRIGHT_TLS_KEY;
if (certificate === undefined || key === undefined) {
  throw new Error("Browser acceptance requires TLS certificate and key");
}

// Use the real public ingress policy and route catalog. The fixture Core has no domain authority;
// individual browser scenarios supply explicit HTTP responses at their public route boundaries.
const worker = makePublicWorker(makeWorkerTelemetry(() => undefined));
const admissionKeyLength = 32;
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
          Promise.resolve(
            forwarded instanceof Request && new URL(forwarded.url).pathname === "/health"
              ? Response.json({ status: "ok" })
              : Response.json({ status: "unavailable" }, { status: 503 })
          ),
      },
    }),
});

process.stdout.write(`Browser API ingress listening at ${server.url}\n`);
