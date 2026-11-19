import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { Effect, Redacted, Schema } from "effect";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import { openPerformanceBrowser } from "../../../infra/cloudflare/native-acceptance";
import { measureBrowser } from "./journey.mjs";

const shortTimeoutMs = 10000,
  sessionTimeoutMs = 30000,
  success = 200,
  minimumProofLength = 32;
const metadataRevision = Schema.decodeUnknownSync(Schema.Struct({ gitRevision: Schema.String }));
const origins = installedOrigins.acceptance;
const directory = "apps/web/test-results/hosted-browser";
mkdirSync(directory, { recursive: true });
const event = (row) => appendFileSync(directory + "/attempts.jsonl", JSON.stringify(row) + "\n");
const network = process.env.BROWSER_NETWORK;
const view = process.env.BROWSER_VIEW ?? "transactions";
const revision = process.env.BROWSER_RELEASE_REVISION;
let stage = "settings";
try {
  assert.ok(/^[0-9a-f]{40}$/u.test(revision));
  assert.ok(network === "ordinary" || network === "poor");
  const allowedView = Schema.decodeUnknownSync(
    Schema.Literals(["transactions", "budgets", "needs-review", "dashboard", "recurring"])
  )(view);
  assert.ok(
    process.env.NATIVE_STORAGE_ADMISSION === "closed" &&
      process.env.SMOKE_PROOF?.length >= minimumProofLength
  );
  event({
    type: "plan",
    variant: "do",
    revision,
    network,
    view: allowedView,
    fixture: "production-calibration",
    source: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    runner: process.env.RUNNER_ENVIRONMENT,
    attempts: 1,
    comparison: "missing",
    d1: "missing budget-metered browser installation",
    minimumPairs: 30,
  });
  stage = "origin";
  const trace = await fetch(origins.browser + "/cdn-cgi/trace", {
    redirect: "error",
    signal: AbortSignal.timeout(shortTimeoutMs),
  });
  assert.equal(trace.status, success);
  const lines = await trace.text();
  const country = /^loc=([A-Z]{2})$/mu.exec(lines)?.[1];
  const colo = /^colo=([A-Z]{3})$/mu.exec(lines)?.[1];
  assert.ok(country && colo);
  event({
    type: "origin",
    country,
    colo,
    source: "Cloudflare trace at browser hostname",
    colombianEgress: country === "CO",
  });
  stage = "release";
  const metadata = await fetch(origins.browser + "/deployment-metadata.json", {
    redirect: "error",
    signal: AbortSignal.timeout(shortTimeoutMs),
  });
  assert.equal(metadataRevision(await metadata.json()).gitRevision, revision);
  stage = "provider-websession";
  const secret = Redacted.make(process.env.SMOKE_PROOF);
  const session = await Effect.runPromise(
    openPerformanceBrowser(
      {
        revision,
        proof: secret,
        send: (request) =>
          Effect.tryPromise({
            try: () =>
              fetch(request, { redirect: "manual", signal: AbortSignal.timeout(sessionTimeoutMs) }),
            catch: () => Error("Hosted browser signup transport unavailable"),
          }),
      },
      network === "ordinary" ? "performance-1" : "performance-2"
    )
  );
  stage = "fresh-view";
  await measureBrowser({
    origins,
    session: Redacted.value(session),
    network,
    view: allowedView,
    event,
    environment: {
      BROWSER_ORIGIN: origins.browser,
      RELEASE_GIT_SHA: revision,
      SMOKE_PROOF: Redacted.value(secret),
      RECOVERY_ISOLATION: "isolated",
      NATIVE_STORAGE_ADMISSION: "closed",
    },
  });
  event({
    type: "result",
    outcome: "completed pilot",
    comparison: "missing",
    audit: "missing independent hosted counts",
  });
} catch {
  // Assertions and browser errors may contain headers, cookies or entire response bodies.
  event({ type: "result", outcome: "failed", stage, comparison: "missing" });
  process.stderr.write("Closed native browser observation failed during " + stage + "\n");
  process.exitCode = 1;
}
