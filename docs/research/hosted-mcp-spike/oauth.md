# Synthetic OAuth browser-exchange fixture

Extract the JavaScript block into `oauth.mjs` in the isolated directory. Disposable loopback research only: approval is automatic, no real User/session exists, and registration/storage/admission are not production security. Never deploy. Metadata documents are operator-supplied; arbitrary URLs are never fetched by this simulator.

```js
// Disposable loopback simulator: automatic browser approval is NOT Fidy authority.
import { createHash, randomBytes } from "node:crypto";
import { makeProtocol } from "./server.mjs";
export function makeOAuthFixture({
  port = 19770,
  legacy = false,
  cimd = false,
  wrongIssuer = false,
  metadataClients = {},
} = {}) {
  const protocol = makeProtocol(legacy);
  const clients = new Map(Object.entries(metadataClients));
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const events = [];
  const secret = () => randomBytes(32).toString("base64url");
  const json = (body, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  let issuer;
  let resource;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/evidence") return json(events);
      // Operator-only synthetic fault injection; this fixture has no real credentials/data.
      if (url.pathname === "/expire-access" && request.method === "POST") {
        access.clear();
        events.push({ event: "access-expired" });
        return json({ expired: true });
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        events.push({ event: "protected-resource-discovery" });
        return json({ resource, authorization_servers: [issuer], scopes_supported: ["read"] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        events.push({ event: "issuer-discovery", cimdAdvertised: cimd });
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
          client_id_metadata_document_supported: cimd,
        });
      }
      if (url.pathname === "/register") {
        const metadata = await request.json();
        const id = secret();
        clients.set(id, metadata.redirect_uris);
        events.push({
          event: "registration",
          mechanism: "DCR",
          name: metadata.client_name,
          redirects: metadata.redirect_uris,
          grantTypes: metadata.grant_types,
        });
        return json({ ...metadata, client_id: id, token_endpoint_auth_method: "none" }, 201);
      }
      if (url.pathname === "/authorize") {
        const input = Object.fromEntries(url.searchParams);
        // Metadata documents are supplied by the operator, never fetched from arbitrary URLs.
        const metadataClient = input.client_id?.startsWith("https://");
        const registered = clients.get(input.client_id);
        const redirectValid =
          registered?.some((uri) => {
            if (uri === input.redirect_uri) return true;
            if (!metadataClient) return false;
            const actual = new URL(input.redirect_uri);
            const expected = new URL(uri);
            const loopback =
              expected.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname);
            actual.port = expected.port;
            return loopback && actual.href === expected.href;
          }) ?? false;
        events.push({
          event: "authorization",
          mechanism: metadataClient ? "CIMD" : "DCR",
          ...(metadataClient ? { metadataClientId: input.client_id } : {}),
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
        callback.searchParams.set("iss", wrongIssuer ? `${issuer}/wrong` : issuer);
        events.push({ event: "callback", issuerMatches: !wrongIssuer });
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
        let client;
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
          client = bound.client_id;
          codes.delete(input.code);
        } else if (input.grant_type === "refresh_token") {
          client = refresh.get(input.refresh_token);
          const valid =
            client !== undefined && client === input.client_id && input.resource === resource;
          events.push({
            event: "refresh",
            accepted: valid,
            resourceBound: input.resource === resource,
          });
          if (!valid) return json({ error: "invalid_grant" }, 400);
          refresh.delete(input.refresh_token);
        } else return json({ error: "unsupported_grant_type" }, 400);
        const token = secret();
        const rotated = secret();
        access.set(token, Date.now() + 600_000);
        refresh.set(rotated, client);
        return json({
          access_token: token,
          token_type: "Bearer",
          expires_in: 600,
          refresh_token: rotated,
          scope: "read",
        });
      }
      if (url.pathname === "/mcp") {
        const deadline = access.get(request.headers.get("authorization")?.replace(/^Bearer /, ""));
        if (deadline === undefined || deadline <= Date.now())
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
        for (const message of Array.isArray(payload) ? payload : [payload])
          events.push({
            event: "mcp",
            method: message.method,
            version: request.headers.get("mcp-protocol-version"),
            metadataVersion: message.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
          });
        const response = await protocol.handler(request);
        events.push({ event: "mcp-response", status: response.status });
        return response;
      }
      return new Response(null, { status: 404 });
    },
  });
  issuer = String(server.url).replace(/\/$/, "");
  resource = `${issuer}/mcp`;
  return {
    server,
    events,
    dispose: async () => {
      await server.stop(true);
      await protocol.dispose();
    },
  };
}
if (import.meta.main) {
  if (!process.argv.includes("--synthetic"))
    throw new Error("Explicit --synthetic required; never deploy");
  const metadataClients = process.env.SPIKE_METADATA_CLIENTS
    ? JSON.parse(process.env.SPIKE_METADATA_CLIENTS)
    : {};
  const fixture = makeOAuthFixture({
    port: Number(process.env.SPIKE_PORT ?? 19770),
    legacy: process.argv.includes("--legacy"),
    cimd: process.argv.includes("--cimd"),
    wrongIssuer: process.argv.includes("--wrong-issuer"),
    metadataClients,
  });
  console.log(`Synthetic fixture listening on loopback port ${fixture.server.port}`);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      void fixture.dispose().then(() => process.exit(0));
    });
}
```
