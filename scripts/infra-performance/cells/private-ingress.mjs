// The pinned Ingress remains private. Only the experiment controller knows this expiring key.
import { timingSafeEqual } from "node:crypto";

/** @import {IngressEnvironment, PinnedIngress} from "./contracts.d.mts" */
const fixed = [
  "POST /web/pairings",
  "POST /web/pairings/redeem",
  "GET /web/session/binding",
  "GET /transactions?limit=25",
];
export const browserReads = [
  "/web/session/binding?context=transactions",
  "/web/session/binding",
  "/web/consent",
  "/ingestion/review-workspace?limit=0&status=pending",
  "/transactions?limit=25&from=2026-11-01T05%3A00%3A00.000Z&to=2026-12-01T05%3A00%3A00.000Z",
  "/user",
];
const enc = new TextEncoder();
/** @param {string} value Experiment proof. */
const hash = (value) => crypto.subtle.digest("SHA-256", enc.encode(value));
const keyBytes = 32;
/**
 * @param {Request} request Scoped request.
 * @param {IngressEnvironment} env Experiment configuration.
 * @param {ReadonlySet<string>} paths Exact paths for this bundle.
 */
const admitted = async (request, env, paths) => {
  const url = new URL(request.url);
  const deadline = Number(env.EXPERIMENT_DEADLINE);
  if (
    !Number.isSafeInteger(deadline) ||
    Date.now() >= deadline ||
    !env.EXPERIMENT_KEY ||
    env.EXPERIMENT_KEY.length < keyBytes
  ) {
    return false;
  }
  if (!paths.has(request.method + " " + url.pathname + url.search)) return false;
  return timingSafeEqual(
    await hash(env.EXPERIMENT_KEY),
    await hash(request.headers.get("x-fidy-comparison-key") ?? "")
  );
};
/** @param {ReadonlyArray<string>} inspectionIds Signed original IDs.
 * @param {{mutationTarget:string|null, assets:Record<string,[string,string]>}} browser Browser fixture and assets.
 */
const allowedRoutes = (inspectionIds, { mutationTarget, assets }) => {
  const paths = new Set([...fixed, ...inspectionIds.map((id) => "GET /transactions/" + id)]);
  if (mutationTarget && inspectionIds.includes(mutationTarget)) {
    for (const path of Object.keys(assets)) paths.add("GET /_comparison_web/" + path);
    paths.add("PUT /transactions/" + mutationTarget);
    paths.add("POST /operations/atomic-batch");
    for (const path of browserReads) {
      paths.add("GET " + path);
      paths.add("OPTIONS " + path);
    }
  }
  return paths;
};
/**
 * @param {PinnedIngress} ingress Frozen application Ingress.
 * @param {ReadonlyArray<string>} inspectionIds Synthetic Transaction IDs verified at bundle time.
 * @param {{mutationTarget:string|null, assets:Record<string,[string,string]>}} browser Bounded browser fixture and web bundle.
 */
export const privateIngress = (
  ingress,
  inspectionIds = [],
  browser = { mutationTarget: null, assets: {} }
) => {
  const { assets } = browser;
  const paths = allowedRoutes(inspectionIds, browser);
  /** @type {string | undefined} */
  let born;
  let requests = 0;
  return {
    /**
     * @param {Request} request Scoped request.
     * @param {IngressEnvironment} env Experiment configuration.
     */
    async fetch(request, env) {
      if (!(await admitted(request, env, paths))) {
        return new Response(null, { status: 403 });
      }
      const path = new URL(request.url).pathname;
      if (path.startsWith("/_comparison_web/")) {
        const asset = assets[path.slice("/_comparison_web/".length)];
        if (!asset) return new Response(null, { status: 403 });
        const [type, bytes] = asset;
        return new Response(Uint8Array.fromBase64(bytes), {
          headers: {
            "content-type": type,
            "content-encoding": "gzip",
            "cache-control": "private, no-store",
            "x-fidy-comparison-worker": env.CF_VERSION_METADATA.id,
          },
          encodeBody: "manual",
        });
      }
      born ??= crypto.randomUUID();
      const invocation = ++requests;
      const headers = new Headers(request.headers);
      headers.delete("x-fidy-comparison-key");
      const started = Date.now();
      const original = await ingress.fetch(new Request(request, { headers }), env);
      const body = await original.arrayBuffer();
      const reply = new Headers(original.headers);
      reply.set("x-reference-backend-ms", String(Date.now() - started));
      reply.set("x-fidy-comparison-worker", env.CF_VERSION_METADATA.id);
      reply.set("x-fidy-comparison-incarnation", born);
      reply.set("x-fidy-comparison-invocation", String(invocation));
      return new Response(body.byteLength || original.body !== null ? body : null, {
        status: original.status,
        headers: reply,
      });
    },
  };
};
