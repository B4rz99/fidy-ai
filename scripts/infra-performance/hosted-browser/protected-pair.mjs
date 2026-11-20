// The parent holds both durable account claims and passes the original Sessions on stdin.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import { signAcceptanceRequest } from "../../../apps/server/cloudflare/release-isolation/operations";
import {
  acceptanceLifetimeMs,
  acceptanceProofHeader,
} from "../../../apps/server/cloudflare/release-isolation/contract";
import { Effect } from "effect";
import { parseConfig, parseCost, parseDeployment, parseReport } from "./contracts";
import { runBrowser } from "./captured-profile.mjs";
import { isColombianEgress, parseTrace } from "./origin.mjs";
import { proveScopedCorrection } from "./scoped-correction.mjs";

/** @import {PairConfig, PairContext, Dispatch, PairHttp, PairEvidence, Variant} from "./contracts" */
/** @typedef {(incoming: Request)=>Promise<Response>} Forward */
/** @typedef {(index:number, action:()=>Promise<void>)=>Promise<void>} Turn */
const pairs = 30;
const percentile = 0.95;
const minimumRatio = 1.8;
const maximumPreflights = 67;
const requestTimeoutMs = 30_000;
const traceTimeoutMs = 10_000;
const correctionIntervalMs = 750;
const ok = 200;
const noContent = 204;
const notFound = 404;
const firstError = 400;
/** @type {ReadonlyArray<Variant>} */
const variants = ["d1", "do"];

const native = installedOrigins.acceptance;
const frozen = { browser: "https://app.fidyapp.com", api: "https://api.fidyapp.com" };
const paths = new Set(["/app/transactions", "/favicon.ico"]);
/** @param {string} path Request path. */
const assetPath = (path) => paths.has(path) || /^\/assets\/[a-zA-Z0-9_./-]+$/u.test(path);
/** @param {Uint8Array} bytes Uncompressed response bytes. */
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** @param {Variant} variant Installation under observation. */
const api = (variant) => (variant === "d1" ? frozen : native);
/** @param {PairConfig} config Admitted browser workload. @param {Variant} variant Installation under observation. */
const session = (config, variant) => (variant === "d1" ? config.d1.session : config.native.session);
/** @param {PairConfig} config Admitted browser workload. */
const available = (config) =>
  assert.ok(Date.now() < config.deadline, "Protected browser reservation expired");

/** @param {number[]} values Complete timing samples. */
const stats = (values) => {
  assert.equal(values.length, pairs);
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    count: pairs,
    median: (sorted[pairs / 2 - 1] + sorted[pairs / 2]) / 2,
    p95: sorted[Math.ceil(pairs * percentile) - 1],
    maximum: sorted[pairs - 1],
    standardDeviation: Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
    ),
  };
};

/** @param {PairConfig} config Admitted browser workload. */
const verifyConfig = (config) => {
  assert.equal(config.native.web.browser, native.browser);
  assert.equal(config.native.web.api, native.api);
  assert.match(config.native.revision, /^[a-f0-9]{40}$/u);
  assert.match(
    config.d1.url,
    /^https:\/\/fidy-2259-[a-f0-9]{12}-ingress\.[a-z0-9-]+\.workers\.dev$/u
  );
};

/** @param {PairContext} context Paired browser owner context. @param {Variant} variant Installation under observation. @returns {Forward} Observed result. */
const forwardWeb =
  ({ config, http }, variant) =>
  async (incoming) => {
    available(config);
    const url = new URL(incoming.url);
    assert.equal(url.origin, api(variant).browser);
    if (!assetPath(url.pathname)) return new Response(null, { status: notFound });
    const path = url.pathname === "/app/transactions" ? "index.html" : url.pathname.slice(1);
    if (variant === "do") {
      const reply = await http(incoming.url, {
        headers: { "accept-encoding": "gzip" },
        redirect: "error",
        decompress: false,
      });
      return new Response(reply.body, { status: reply.status, headers: reply.headers });
    }
    if (!Object.hasOwn(config.d1.assets, path)) return new Response(null, { status: notFound });
    const reply = await http(config.d1.url + "/_comparison_web/" + path, {
      headers: { "x-fidy-comparison-key": config.d1.key },
      redirect: "error",
      decompress: false,
    });
    assert.equal(reply.status, ok);
    assert.equal(reply.headers.get("x-fidy-comparison-worker"), config.d1.version);
    const bytes = new Uint8Array(await reply.arrayBuffer());
    const plain = reply.headers.get("content-encoding") === "gzip" ? Bun.gunzipSync(bytes) : bytes;
    assert.equal(plain.byteLength, config.d1.assets[path].bytes);
    assert.equal(digest(plain), config.d1.assets[path].sha256);
    return new Response(bytes, { headers: reply.headers });
  };

/** @param {PairContext} context Paired browser owner context. @param {Variant} variant Installation under observation. @param {Request} incoming Original browser request. */
const reserveRequest = ({ config, profile, preflights, evidence }, variant, incoming) => {
  const origins = api(variant);
  const url = new URL(incoming.url);
  assert.equal(url.origin, origins.api);
  assert.equal(incoming.headers.get("origin"), origins.browser);
  const isPreflight = incoming.method === "OPTIONS";
  const method = isPreflight
    ? incoming.headers.get("access-control-request-method")
    : incoming.method;
  const route = method + " " + url.pathname + url.search;
  /** @type {Dispatch} */
  const observed = {
    variant,
    method: incoming.method,
    path: url.pathname.startsWith("/transactions/") ? "/transactions/:original" : url.pathname,
  };
  evidence.dispatches.push(observed);
  assert.ok(Object.hasOwn(config.allowed, route), "Unquoted browser route");
  if (isPreflight) {
    assert.equal(method, "GET");
    assert.ok(++preflights[variant] <= maximumPreflights);
  } else {
    assert.equal(incoming.headers.get("cookie"), session(config, variant).cookie);
    if (url.pathname !== "/web/session/binding") {
      assert.equal(incoming.headers.get("fidy-session-binding"), session(config, variant).binding);
    }
    assert.ok(profile[variant][route]-- > 0, "Exhausted route reservation");
  }
  return { isPreflight, route, observed };
};

/** @param {PairConfig} config Admitted browser workload. @param {Variant} variant Installation under observation. @param {Request} incoming Original browser request. */
const signedRequest = async (config, variant, incoming) => {
  const origins = api(variant);
  const url = new URL(incoming.url);
  const headers = new Headers(incoming.headers);
  headers.delete("accept-encoding");
  const base = variant === "d1" ? config.d1.url : origins.api;
  const request = new Request(base + url.pathname + url.search, {
    method: incoming.method,
    headers,
    redirect: "error",
    ...(incoming.body === null ? {} : { body: await incoming.arrayBuffer() }),
  });
  if (variant === "d1") request.headers.set("x-fidy-comparison-key", config.d1.key);
  else {
    request.headers.set(
      acceptanceProofHeader,
      await Effect.runPromise(
        signAcceptanceRequest({
          request,
          boundary: "ingress",
          environment: {
            BROWSER_ORIGIN: native.browser,
            RELEASE_GIT_SHA: config.native.revision,
            SMOKE_PROOF: process.env.SMOKE_PROOF,
            RECOVERY_ISOLATION: "isolated",
            NATIVE_STORAGE_ADMISSION: "closed",
          },
          deadline: Math.min(config.deadline, Date.now() + acceptanceLifetimeMs),
        })
      )
    );
  }
  return request;
};

/** @param {PairContext} context Paired browser owner context. @param {Response} reply Complete transport reply. @param {{isPreflight:boolean,route:string}} selection Reserved route. */
const recordD1 = ({ config, evidence }, reply, { isPreflight, route }) => {
  assert.equal(reply.headers.get("x-fidy-comparison-worker"), config.d1.version);
  if (!isPreflight) {
    const cost = parseCost(reply.headers.get("x-fidy-comparison-cost") ?? "");
    /** @type {ReadonlyArray<keyof typeof cost>} */
    const counters = ["rowsRead", "rowsWritten"];
    for (const field of counters) {
      assert.ok(
        Number.isSafeInteger(cost[field]) &&
          cost[field] >= 0 &&
          cost[field] <= config.caps[route][field]
      );
      evidence.actualD1[field] += cost[field];
      assert.ok(evidence.actualD1[field] <= config.maximum[field]);
    }
  } else assert.equal(reply.status, noContent);
};

/** @param {PairContext} context Paired browser owner context. @param {Variant} variant Installation under observation. @returns {Forward} Observed result. */
const forward = (context, variant) => async (incoming) => {
  const { http, config } = context;
  available(config);
  const selection = reserveRequest(context, variant, incoming);
  const request = await signedRequest(config, variant, incoming);
  const reply = await http(request, {
    redirect: "error",
    decompress: true,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  Object.assign(selection.observed, { status: reply.status });
  if (variant === "d1") recordD1(context, reply, selection);
  const exposed = new Headers(reply.headers);
  for (const name of [
    "content-encoding",
    "content-length",
    "x-fidy-comparison-cost",
    acceptanceProofHeader,
  ]) {
    exposed.delete(name);
  }
  return new Response(reply.body, { status: reply.status, headers: exposed });
};

/** @param {PairContext} context Paired browser owner context. */
const pairedTurns = ({ config, evidence }) => {
  const order = Array.from({ length: pairs }, (_, index) =>
    index % 2 ? ["do", "d1"] : ["d1", "do"]
  ).flat();
  const slots = Array.from({ length: order.length + 1 }, () => Promise.withResolvers());
  slots[0].resolve();
  const stop = new AbortController();
  const aborted = new Promise((_, reject) =>
    stop.signal.addEventListener("abort", () => reject(Error("Paired run stopped")), { once: true })
  );
  aborted.catch(() => undefined);
  /** @param {Variant} variant Installation under observation. @returns {Turn} Observed result. */
  const timed = (variant) => async (index, action) => {
    const slot = 2 * index + (order[index * 2] === variant ? 0 : 1);
    await Promise.race([slots[slot].promise, aborted]);
    available(config);
    evidence.observations.push({ index, variant, offered: true });
    await action();
    slots[slot + 1].resolve();
  };
  return { timed, stop };
};

/** @param {PairContext} context Paired browser owner context. */
const origin = async ({ config, http, evidence }) => {
  /** @param {string} host Acceptance host. */
  const trace = async (host) => {
    const response = await http(host + "/cdn-cgi/trace", {
      redirect: "error",
      signal: AbortSignal.timeout(traceTimeoutMs),
    });
    assert.equal(response.status, ok);
    return parseTrace(await response.text());
  };
  const [apiTrace, browserTrace] = await Promise.all([trace(native.api), trace(native.browser)]);
  const hosts = { api: apiTrace, browser: browserTrace };
  const colombianEgress = isColombianEgress(hosts);
  if (evidence.environment === "deployed Cloudflare") {
    assert.ok(colombianEgress, "Colombia egress changed before measurement");
  }
  const metadata = parseDeployment(
    await (await http(native.browser + "/deployment-metadata.json", { redirect: "error" })).json()
  );
  assert.equal(metadata.gitRevision, config.native.web.revision);
  assert.equal(metadata.contractDigest, config.native.web.contractDigest);
  return { hosts, colombianEgress, nativeWebRevision: metadata.gitRevision };
};

/** @param {PairContext} context Paired browser owner context. */
const measureBrowsers = async (context) => {
  const { config } = context;
  const { timed, stop } = pairedTurns(context);
  const results = await Promise.allSettled(
    variants.map((variant) =>
      runBrowser({
        variant,
        origins: api(variant),
        cookie: session(config, variant).cookie,
        workspace: config.expected.workspace,
        expected: config.expected.history,
        forward: forward(context, variant),
        forwardWeb: forwardWeb(context, variant),
        turn: timed(variant),
      }).catch((error) => {
        stop.abort();
        throw error;
      })
    )
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) {
    throw failed.reason instanceof Error ? failed.reason : Error("Browser observation failed");
  }
};

/** @param {number|undefined} value Observed field. */
const observedNumber = (value) => {
  assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0);
  return value;
};
/** @param {PairEvidence} evidence Accumulated browser observations. @param {ReturnType<typeof parseReport>} report Verified browser artifact. */
const measures = (evidence, report) => {
  const refresh = report.events
    .filter((event) => event.stage === "refresh" && event.complete)
    .map((event) => observedNumber(event.milliseconds));
  assert.equal(refresh.length, pairs);
  assert.ok(refresh.every((value) => value > 0));
  const http = report.events.filter((event) => event.stage === "complete-http");
  const elapsed = http.map((event) => observedNumber(event.milliseconds));
  const bytes = http.map((event) => observedNumber(event.bodyBytes));
  evidence.observations
    .filter((event) => event.variant === report.variant)
    .forEach((item, index) => {
      Object.assign(item, {
        completed: true,
        milliseconds: refresh[index],
        httpMs: elapsed[index],
        bodyBytes: bytes[index],
      });
    });
  return { browser: stats(refresh), http: stats(elapsed), bytes: stats(bytes) };
};
/** @param {{d1: ReturnType<typeof stats>, do:ReturnType<typeof stats>}} values Complete timing samples. */
const boundary = (values) => {
  const ratio = values.d1.p95 / values.do.p95;
  return {
    ...values,
    ratio,
    threshold: minimumRatio,
    status: ratio >= minimumRatio ? "pass" : "fail",
  };
};
/** @param {PairContext} context Paired browser owner context. */
const recordMeasures = async ({ dir, evidence }) => {
  const d1 = parseReport(await Bun.file(join(dir, "ordinary-d1.json")).json());
  const nativeEvidence = parseReport(await Bun.file(join(dir, "ordinary-do.json")).json());
  assert.equal(d1.variant, "d1");
  assert.equal(nativeEvidence.variant, "do");
  assert.deepEqual(d1.snapshots, nativeEvidence.snapshots);
  const frozenStats = measures(evidence, d1),
    nativeStats = measures(evidence, nativeEvidence);
  const measured = {
    browser: { d1: frozenStats.browser, do: nativeStats.browser },
    http: { d1: frozenStats.http, do: nativeStats.http },
    bytes: { d1: frozenStats.bytes, do: nativeStats.bytes },
  };
  evidence.stats = measured;
  evidence.boundaries = {
    "ordinary.transactions.refresh.browser": boundary(measured.browser),
    "ordinary.transactions.refresh.http": boundary(measured.http),
  };
};

/** @param {PairContext} context Paired browser owner context. @param {Variant} variant Installation under observation. */
const checkMutation = async (context, variant) => {
  const { config, profile } = context;
  const invoke = forward(context, variant),
    origins = api(variant),
    bound = session(config, variant);
  const result = await proveScopedCorrection(
    config.expected.history,
    async (method, path, body) => {
      await Bun.sleep(correctionIntervalMs);
      return invoke(
        new Request(origins.api + path, {
          method,
          headers: {
            cookie: bound.cookie,
            "fidy-session-binding": bound.binding,
            origin: origins.browser,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      );
    }
  );
  assert.ok(Object.values(profile[variant]).every((count) => count === 0));

  return result;
};

/** @param {PairContext} context Paired browser owner context. @param {Variant} variant Installation under observation. */
const keepPartial = async ({ dir, evidence }, variant) => {
  const file = Bun.file(join(dir, "ordinary-" + variant + ".json"));
  if (await file.exists()) {
    const partial = parseReport(await file.json());
    evidence[variant + "Progress"] = partial.events.filter(
      (event) =>
        event.stage === "incomplete" ||
        event.stage === "refresh" ||
        (event.status ?? 0) >= firstError ||
        Boolean(event.failed) ||
        Boolean(event.rejected)
    );
  }
};

/** @param {PairConfig} config Admitted browser workload. @param {PairHttp} http Bounded HTTP transport. @param {string} environment Named observation environment. */
export const comparePair = async (config, http, environment) => {
  verifyConfig(config);
  const dir = process.env.FIDY_DIAGNOSTIC_DIR;
  assert.ok(dir);
  /** @type {PairEvidence} */
  const evidence = {
    environment,
    verified: false,
    origin: null,
    dispatches: [],
    observations: [],
    actualD1: { rowsRead: 0, rowsWritten: 0 },
    network: "ordinary",
    fixture: "eight originals and one link; empty unrelated workspace",
  };
  const save = () => Bun.write(join(dir, "comparison.json"), JSON.stringify(evidence));
  const profile = { d1: { ...config.allowed }, do: { ...config.allowed } };
  const preflights = { d1: 0, do: 0 };
  const context = { config, http, evidence, preflights, profile, dir };
  try {
    evidence.origin = await origin(context);
    await measureBrowsers(context);
    await recordMeasures(context);
    const mutation = {
      d1: await checkMutation(context, "d1"),
      do: await checkMutation(context, "do"),
    };
    assert.deepEqual(mutation.d1, mutation.do);
    Object.assign(evidence, {
      mutation: mutation.d1,
      preflights,
      verified: true,
      lifecycle: "native lifecycle unobserved",
      assetRevision: {
        native: config.native.web.revision,
        d1: "fb53d9e755c14393048dc945fc0b7f117730d872",
      },
    });
  } catch (error) {
    evidence.failure = error instanceof Error ? error.name : "Unknown";
    // Preserve the failing source location without serializing an assertion's actual or expected values.
    evidence.failureLocation =
      /(?:protected-pair|fresh-transactions|captured-profile|scoped-correction)\.mjs:\d+:\d+/u.exec(
        error instanceof Error ? (error.stack ?? "") : ""
      )?.[0];
    await Promise.all(variants.map((variant) => keepPartial(context, variant)));
  } finally {
    await save();
  }
  return evidence;
};
if (import.meta.main) {
  const result = await comparePair(
    parseConfig(await Bun.stdin.json()),
    fetch,
    "deployed Cloudflare"
  );
  if (!result.verified) process.exitCode = 1;
}
