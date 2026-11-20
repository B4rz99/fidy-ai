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
import { runBrowser } from "./captured-profile.mjs";
import { isColombianEgress, parseTrace } from "./origin.mjs";
import { proveScopedCorrection } from "./scoped-correction.mjs";

function stats(values) {
  assert.equal(values.length, 30);
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0));
  const sorted = values.toSorted((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    count: 30,
    median: (sorted[14] + sorted[15]) / 2,
    p95: sorted[28],
    maximum: sorted[29],
    standardDeviation: Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
    ),
  };
}

export async function comparePair(config, http, environment) {
  const dir = process.env.FIDY_DIAGNOSTIC_DIR;
  const native = installedOrigins.acceptance;
  const frozen = { browser: "https://app.fidyapp.com", api: "https://api.fidyapp.com" };
  assert.equal(config.native.web.browser, native.browser);
  assert.equal(config.native.web.api, native.api);
  assert.match(config.native.revision, /^[a-f0-9]{40}$/u);
  assert.match(
    config.d1.url,
    /^https:\/\/fidy-2259-[a-f0-9]{12}-ingress\.[a-z0-9-]+\.workers\.dev$/u
  );
  const evidence = {
    environment,
    verified: false,
    origin: null,
    observations: [],
    actualD1: { rowsRead: 0, rowsWritten: 0 },
    network: "ordinary",
    fixture: "eight originals and one link; empty unrelated workspace",
  };
  const save = () => Bun.write(join(dir, "comparison.json"), JSON.stringify(evidence));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const available = () => {
    assert.ok(Date.now() < config.deadline, "Protected browser reservation expired");
  };
  const profile = { d1: { ...config.allowed }, do: { ...config.allowed } };
  const preflights = { d1: 0, do: 0 };
  const api = (variant) => (variant === "d1" ? frozen : native);
  const session = (variant) => (variant === "d1" ? config.d1.session : config.native.session);
  const routeFor = (method, url) => method + " " + url.pathname + url.search;
  const paths = new Set(["/app/transactions", "/favicon.ico"]);
  const assetPath = (path) => paths.has(path) || /^\/assets\/[a-zA-Z0-9_./-]+$/u.test(path);
  const forwardWeb = (variant) => async (incoming) => {
    available();
    const url = new URL(incoming.url);
    assert.equal(url.origin, api(variant).browser);
    if (!assetPath(url.pathname)) return new Response(null, { status: 404 });
    const path = url.pathname === "/app/transactions" ? "index.html" : url.pathname.slice(1);
    if (variant === "do") {
      const reply = await http(incoming.url, {
        headers: { "accept-encoding": "gzip" },
        redirect: "error",
        decompress: false,
      });
      return new Response(reply.body, { status: reply.status, headers: reply.headers });
    }
    if (!Object.hasOwn(config.d1.assets, path)) return new Response(null, { status: 404 });
    const reply = await http(config.d1.url + "/_comparison_web/" + path, {
      headers: { "x-fidy-comparison-key": config.d1.key },
      redirect: "error",
      decompress: false,
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("x-fidy-comparison-worker"), config.d1.version);
    const bytes = new Uint8Array(await reply.arrayBuffer());
    const plain = reply.headers.get("content-encoding") === "gzip" ? Bun.gunzipSync(bytes) : bytes;
    assert.equal(plain.byteLength, config.d1.assets[path].bytes);
    assert.equal(digest(plain), config.d1.assets[path].sha256);
    return new Response(bytes, { headers: reply.headers });
  };
  const forward = (variant) => async (incoming) => {
    available();
    const origins = api(variant);
    const url = new URL(incoming.url);
    assert.equal(url.origin, origins.api);
    assert.equal(incoming.headers.get("origin"), origins.browser);
    const isPreflight = incoming.method === "OPTIONS";
    const method = isPreflight
      ? incoming.headers.get("access-control-request-method")
      : incoming.method;
    const route = routeFor(method, url);
    assert.ok(Object.hasOwn(config.allowed, route), "Unquoted browser route");
    if (isPreflight) {
      assert.equal(method, "GET");
      assert.ok(++preflights[variant] <= 67);
    } else {
      assert.equal(incoming.headers.get("cookie"), session(variant).cookie);
      if (url.pathname !== "/web/session/binding")
        assert.equal(incoming.headers.get("fidy-session-binding"), session(variant).binding);
      assert.ok(profile[variant][route]-- > 0, "Exhausted route reservation");
    }
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
    else
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
    const reply = await http(request, {
      redirect: "error",
      decompress: true,
      signal: AbortSignal.timeout(30000),
    });
    if (variant === "d1") {
      assert.equal(reply.headers.get("x-fidy-comparison-worker"), config.d1.version);
      if (!isPreflight) {
        const cost = JSON.parse(reply.headers.get("x-fidy-comparison-cost"));
        for (const field of ["rowsRead", "rowsWritten"]) {
          assert.ok(
            Number.isSafeInteger(cost[field]) &&
              cost[field] >= 0 &&
              cost[field] <= config.caps[route][field]
          );
          evidence.actualD1[field] += cost[field];
          assert.ok(evidence.actualD1[field] <= config.maximum[field]);
        }
      } else assert.equal(reply.status, 204);
    }
    const exposed = new Headers(reply.headers);
    for (const name of [
      "content-encoding",
      "content-length",
      "x-fidy-comparison-cost",
      acceptanceProofHeader,
    ])
      exposed.delete(name);
    return new Response(reply.body, { status: reply.status, headers: exposed });
  };

  const order = Array.from({ length: 30 }, (_, i) => (i % 2 ? ["do", "d1"] : ["d1", "do"])).flat();
  const slots = Array.from({ length: 61 }, () => Promise.withResolvers());
  slots[0].resolve();
  const stop = new AbortController();
  const aborted = new Promise((_, reject) =>
    stop.signal.addEventListener("abort", () => reject(Error("Paired run stopped")), { once: true })
  );
  aborted.catch(() => undefined);
  const timed = (variant) => async (index, action) => {
    const slot = 2 * index + (order[index * 2] === variant ? 0 : 1);
    await Promise.race([slots[slot].promise, aborted]);
    available();
    evidence.observations.push({ index, variant, offered: true });
    await action();
    slots[slot + 1].resolve();
  };
  const origin = async () => {
    const hosts = {};
    for (const [name, host] of Object.entries(native)) {
      const response = await http(host + "/cdn-cgi/trace", {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200);
      hosts[name] = parseTrace(await response.text());
    }
    const colombianEgress = isColombianEgress(hosts);
    if (environment === "deployed Cloudflare")
      assert.ok(colombianEgress, "Colombia egress changed before measurement");
    const metadata = await (
      await http(native.browser + "/deployment-metadata.json", { redirect: "error" })
    ).json();
    assert.equal(metadata.gitRevision, config.native.web.revision);
    assert.equal(metadata.contractDigest, config.native.web.contractDigest);
    return { hosts, colombianEgress, nativeWebRevision: metadata.gitRevision };
  };
  try {
    evidence.origin = await origin();
    const measured = { browser: {}, http: {}, bytes: {} };
    await Promise.all(
      ["d1", "do"].map((variant) =>
        runBrowser({
          variant,
          origins: api(variant),
          cookie: session(variant).cookie,
          workspace: config.expected.workspace,
          expected: config.expected.history,
          forward: forward(variant),
          forwardWeb: forwardWeb(variant),
          turn: timed(variant),
        }).catch((error) => {
          stop.abort();
          throw error;
        })
      )
    );
    const d1 = await Bun.file(join(dir, "ordinary-d1.json")).json();
    const nativeEvidence = await Bun.file(join(dir, "ordinary-do.json")).json();
    assert.deepEqual(d1.snapshots, nativeEvidence.snapshots);
    for (const report of [d1, nativeEvidence]) {
      const all = report.events
        .filter((e) => e.stage === "refresh" && e.complete)
        .map((e) => e.milliseconds);
      assert.equal(all.length, 30);
      assert.ok(all.every((n) => Number.isFinite(n) && n > 0));
      const http = report.events.filter((event) => event.stage === "complete-http");
      measured.browser[report.variant] = stats(all);
      measured.http[report.variant] = stats(http.map((event) => event.milliseconds));
      measured.bytes[report.variant] = stats(http.map((event) => event.bodyBytes));
      evidence.observations
        .filter((e) => e.variant === report.variant)
        .forEach((item, i) => {
          item.completed = true;
          item.milliseconds = all[i];
          item.httpMs = http[i].milliseconds;
          item.bodyBytes = http[i].bodyBytes;
        });
    }
    evidence.stats = measured;
    evidence.boundaries = Object.fromEntries(
      ["browser", "http"].map((kind) => {
        const ratio = measured[kind].d1.p95 / measured[kind].do.p95;
        return [
          "ordinary.transactions.refresh." + kind,
          { ...measured[kind], ratio, threshold: 1.8, status: ratio >= 1.8 ? "pass" : "fail" },
        ];
      })
    );
    const mutation = {};
    for (const variant of ["d1", "do"]) {
      const invoke = forward(variant),
        origins = api(variant),
        bound = session(variant);
      mutation[variant] = await proveScopedCorrection(
        config.expected.history,
        async (method, path, body) => {
          await Bun.sleep(750);
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
    }
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
    evidence.failure = error.name;
  } finally {
    await save();
  }
  return evidence;
}
if (import.meta.main) {
  const result = await comparePair(await Bun.stdin.json(), fetch, "deployed Cloudflare");
  if (!result.verified) process.exitCode = 1;
}
