import { Option } from "effect";
import { sandboxPublicKey } from "./internal/public-key";

const jwksPath = "/connections/bancolombia/sandbox/jwks";
const callbackPath = "/connections/bancolombia/sandbox/callback";

/** Publishes sandbox registration metadata without granting institution or User authority. */
export const bancolombiaSandboxResponse = (request: Request): Option.Option<Response> => {
  const url = new URL(request.url);
  if (url.pathname !== jwksPath && url.pathname !== callbackPath) return Option.none();
  if (request.method !== "GET") {
    return Option.some(
      Response.json({ status: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } })
    );
  }
  if (url.pathname === callbackPath) {
    if (url.search.length > 0) {
      return Option.some(new Response(null, { status: 303, headers: { location: callbackPath } }));
    }
    return Option.some(
      new Response("La autorización de Bancolombia Sandbox aún no está disponible.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    );
  }
  return Option.some(Response.json({ keys: [sandboxPublicKey] }));
};
