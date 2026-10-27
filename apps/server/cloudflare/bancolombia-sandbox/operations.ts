import { Option } from "effect";
import { sandboxPublicKey } from "./contract";

const jwksPath = "/connections/bancolombia/sandbox/jwks";
const callbackPath = "/connections/bancolombia/sandbox/callback";
const maximumCallbackLength = 8192;

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
    if (url.search.length > maximumCallbackLength) {
      return Option.some(new Response(null, { status: 303, headers: { location: callbackPath } }));
    }
    return Option.none();
  }
  return Option.some(Response.json({ keys: [sandboxPublicKey] }));
};
