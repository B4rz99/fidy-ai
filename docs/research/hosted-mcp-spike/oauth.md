# Synthetic OAuth browser-exchange fixture

Extract this block as `oauth.mjs` in the isolated directory. It is intentionally a disposable, loopback-only, in-memory simulator: GET automatically approves, registrations/body input are not production validated, refresh is not a security implementation, and there is no real User or Fidy session. Never deploy it. It emits only bounded-shape observations, not credentials or authorization URLs. Use only with isolated host profiles.

```js
// Loopback-only disposable OAuth fixture. Synthetic approval is NOT Fidy authentication.
import { createHash, randomBytes } from "node:crypto";
import { makeProtocol } from "./server.mjs";
if (!process.argv.includes("--synthetic"))
  throw new Error("Explicit --synthetic is required; not a production OAuth server");
const issuer = "http://127.0.0.1:19770";
const resource = `${issuer}/mcp`;
const protocol = makeProtocol(process.argv.includes("--legacy"));
const clients = new Map();
const codes = new Map();
const access = new Set();
const refresh = new Set();
const events = [];
const secret = () => randomBytes(32).toString("base64url");
const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 19770,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/evidence") return json(events);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      events.push({ event: "protected-resource-discovery" });
      return json({ resource, authorization_servers: [issuer], scopes_supported: ["read"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      events.push({ event: "issuer-discovery" });
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["read"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === "/register") {
      const metadata = await request.json();
      const id = secret();
      clients.set(id, metadata.redirect_uris);
      events.push({
        event: "registration",
        name: metadata.client_name,
        redirects: metadata.redirect_uris,
        grantTypes: metadata.grant_types,
      });
      return json({ ...metadata, client_id: id, token_endpoint_auth_method: "none" }, 201);
    }
    if (url.pathname === "/authorize") {
      const input = Object.fromEntries(url.searchParams);
      const redirectValid = clients.get(input.client_id)?.includes(input.redirect_uri);
      events.push({
        event: "authorization",
        pkce: input.code_challenge_method,
        resourceBound: input.resource === resource,
        redirectValid,
        scope: input.scope,
      });
      if (!redirectValid || input.resource !== resource || input.code_challenge_method !== "S256")
        return json({ error: "invalid_request" }, 400);
      const code = secret();
      codes.set(code, input);
      const callback = new URL(input.redirect_uri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", input.state);
      callback.searchParams.set("iss", issuer);
      return new Response(null, {
        status: 302,
        headers: {
          Location: callback.href,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    if (url.pathname === "/token") {
      const input = Object.fromEntries(new URLSearchParams(await request.text()));
      if (input.grant_type === "authorization_code") {
        const bound = codes.get(input.code);
        const valid =
          bound &&
          bound.client_id === input.client_id &&
          bound.redirect_uri === input.redirect_uri &&
          input.resource === resource &&
          createHash("sha256")
            .update(input.code_verifier ?? "")
            .digest("base64url") === bound.code_challenge;
        events.push({
          event: "code-exchange",
          pkceValid: Boolean(valid),
          resourceBound: input.resource === resource,
        });
        if (!valid) return json({ error: "invalid_grant" }, 400);
        codes.delete(input.code);
      } else if (input.grant_type === "refresh_token") {
        const valid = refresh.delete(input.refresh_token);
        events.push({
          event: "refresh",
          accepted: valid,
          resourceBound: input.resource === resource,
        });
        if (!valid) return json({ error: "invalid_grant" }, 400);
      } else return json({ error: "unsupported_grant_type" }, 400);
      const token = secret();
      const rotated = secret();
      access.add(token);
      refresh.add(rotated);
      setTimeout(() => access.delete(token), 3000);
      return json({
        access_token: token,
        token_type: "Bearer",
        expires_in: 3,
        refresh_token: rotated,
        scope: "read",
      });
    }
    if (url.pathname === "/mcp") {
      if (!access.has(request.headers.get("authorization")?.replace(/^Bearer /, "")))
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="read"`,
          },
        });
      const payload = await request
        .clone()
        .json()
        .catch(() => ({}));
      events.push({
        event: "mcp",
        method: payload.method,
        version: request.headers.get("mcp-protocol-version"),
        metadataVersion: payload.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
      });
      return protocol.handler(request);
    }
    return new Response(null, { status: 404 });
  },
});
console.log("Synthetic OAuth fixture listening on loopback port 19770");
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void server
      .stop(true)
      .then(() => protocol.dispose())
      .then(() => process.exit(0));
  });
```
