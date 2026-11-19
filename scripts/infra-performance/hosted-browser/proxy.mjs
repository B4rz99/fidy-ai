// Chromium resolves only the selected API hostname to this runner-local TLS hop. It still
// generates normal CORS preflights, credentials and binding headers. No script in the page
// receives a proof or the signing key. Both measurement variants use this same transport.
import { Effect } from "effect";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract.ts";
import {
  acceptanceLifetimeMs,
  acceptanceProofHeader,
} from "../../../apps/server/cloudflare/release-isolation/contract.ts";
import { signAcceptanceRequest } from "../../../apps/server/cloudflare/release-isolation/operations.ts";

import { targetId } from "../reference/fresh-transactions.mjs";
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
const finiteJourney = (method, path) =>
  (method === "GET" && reads.has(path)) || (method === "PUT" && path === target);

export function protectedBrowserProxy({ origins, environment, tls, forward = fetch }) {
  const native = environment !== undefined;
  if (
    native &&
    (origins.api !== installedOrigins.acceptance.api ||
      origins.browser !== installedOrigins.acceptance.browser)
  ) {
    throw Error("Unexpected native acceptance host pair");
  }
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    maxRequestBodySize: 65536,
    error: () => new Response(null, { status: 502 }),
    async fetch(incoming) {
      const url = new URL(incoming.url);
      const method =
        incoming.method === "OPTIONS"
          ? incoming.headers.get("access-control-request-method")
          : incoming.method;
      if (
        url.origin !== origins.api ||
        incoming.headers.get("origin") !== origins.browser ||
        !finiteJourney(method, url.pathname)
      )
        return new Response(null, { status: 403 });
      const headers = new Headers(incoming.headers);
      for (const name of [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        acceptanceProofHeader,
      ])
        headers.delete(name);
      // Bun decompresses fetch responses. Ask for identity encoding to preserve their original body.
      headers.set("accept-encoding", "identity");
      const request = new Request(url, {
        method: incoming.method,
        headers,
        redirect: "error",
        ...(incoming.method === "PUT" ? { body: await incoming.arrayBuffer() } : {}),
      });
      if (native) {
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
      const response = await forward(request, { redirect: "error", decompress: false });
      if (response.status >= 300 && response.status < 400)
        return new Response(null, { status: 502 });
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
  });
}
