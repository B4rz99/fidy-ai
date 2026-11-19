// The pinned Ingress remains private. Only the experiment controller knows this expiring key.
import { timingSafeEqual } from "node:crypto";
import ingress from "./public-worker.mjs";

/** @import {IngressEnvironment} from "./contracts.d.mts" */
const paths = new Set([
  "POST /web/pairings",
  "POST /web/pairings/redeem",
  "GET /web/session/binding",
  "GET /transactions?limit=25",
]);
const enc = new TextEncoder();
/** @param {string} value Experiment proof. */
const hash = (value) => crypto.subtle.digest("SHA-256", enc.encode(value));
/** @type {string | undefined} */
let born;
let requests = 0;
const keyBytes = 32;
/**
 * @param {Request} request Scoped request.
 * @param {IngressEnvironment} env Experiment configuration.
 */
const admitted = async (request, env) => {
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
export const worker = {
  /**
   * @param {Request} request Scoped request.
   * @param {IngressEnvironment} env Experiment configuration.
   */
  async fetch(request, env) {
    if (!(await admitted(request, env))) {
      return new Response(null, { status: 403 });
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
