// Chromium resolves only the selected API hostname to this runner-local TLS hop. It still
// generates normal CORS preflights, credentials and binding headers. No script in the page
// receives a proof or the signing key. Both measurement variants use this same transport.
import { Effect } from "effect";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import {
  acceptanceLifetimeMs,
  acceptanceProofHeader,
} from "../../../apps/server/cloudflare/release-isolation/contract";
import { signAcceptanceRequest } from "../../../apps/server/cloudflare/release-isolation/operations";
import { targetId } from "../reference/fresh-transactions.mjs";

/** @typedef {{browser: string, api: string}} Origins */
/** @typedef {import("../../../apps/server/cloudflare/release-isolation/contract").AcceptanceEnvironment} AcceptanceEnvironment */
/** @typedef {(request: Request, options: { redirect: "error", decompress: false }) => Promise<Response>} Forward */
/** @typedef {{origins: Origins, environment?: AcceptanceEnvironment, tls: Bun.TLSOptions, forward?: Forward}} ProxySettings */
const maxRequestBodySize = 65536,
  badGateway = 502,
  forbidden = 403,
  redirectStart = 300,
  redirectEnd = 400;
const target = "/transactions/" + targetId;
const reads = new Set([
  "/transactions",
  target,
  target + "/source-attestations",
  "/categories",
  "/user",
  "/web/session/binding",
  "/web/consent",
  "/web/consent/authorization",
  "/web/subscription",
]);
/**
 * @param {string | null} method Expected HTTP method.
 * @param {string} path Exact API pathname.
 */
const finiteJourney = (method, path) =>
  (method === "GET" && reads.has(path)) || (method === "PUT" && path === target);

/**
 * @param {Request} incoming Request received from the browser.
 * @param {URL} url Original request URL.
 * @param {Origins} origins Installed web and API host pair.
 */
const admitted = (incoming, url, origins) => {
  const method =
    incoming.method === "OPTIONS"
      ? incoming.headers.get("access-control-request-method")
      : incoming.method;
  return (
    url.origin === origins.api &&
    incoming.headers.get("origin") === origins.browser &&
    finiteJourney(method, url.pathname)
  );
};

/**
 * @param {Request} incoming Request received from the browser.
 * @param {URL} url Original request URL.
 * @param {AcceptanceEnvironment | undefined} environment Closed native release settings.
 */
const outbound = async (incoming, url, environment) => {
  const headers = new Headers(incoming.headers);
  for (const name of [
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    acceptanceProofHeader,
  ]) {
    headers.delete(name);
  }
  const request = new Request(url, {
    method: incoming.method,
    headers,
    redirect: "error",
    ...(incoming.method === "PUT" ? { body: await incoming.arrayBuffer() } : {}),
  });
  if (environment) {
    request.headers.set(
      acceptanceProofHeader,
      await Effect.runPromise(
        signAcceptanceRequest({
          environment,
          request,
          boundary: "ingress",
          deadline: Date.now() + acceptanceLifetimeMs,
        })
      )
    );
  }
  return request;
};

/**
 * @param {ProxySettings} settings Bounded transport and release settings.
 */
export const protectedBrowserProxy = ({ origins, environment, tls, forward }) => {
  if (!environment && !forward) {
    throw Error("The D1 browser requires an admitted metered transport");
  }
  if (
    environment &&
    (origins.api !== installedOrigins.acceptance.api ||
      origins.browser !== installedOrigins.acceptance.browser)
  ) {
    throw Error("Unexpected native acceptance host pair");
  }
  const send = forward ?? fetch;
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    maxRequestBodySize,
    error: () => new Response(null, { status: badGateway }),
    async fetch(incoming) {
      const url = new URL(incoming.url);
      if (!admitted(incoming, url, origins)) return new Response(null, { status: forbidden });
      const request = await outbound(incoming, url, environment);
      const response = await send(request, { redirect: "error", decompress: false });
      if (response.status >= redirectStart && response.status < redirectEnd) {
        return new Response(null, { status: badGateway });
      }
      const replyHeaders = new Headers(response.headers);
      replyHeaders.delete(acceptanceProofHeader);
      return new Response(response.body, { status: response.status, headers: replyHeaders });
    },
  });
};
