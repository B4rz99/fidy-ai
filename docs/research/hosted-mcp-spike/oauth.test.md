# Synthetic exchange regression test

Extract the JavaScript block into `oauth.test.mjs` in the isolated directory. Disposable loopback research only: approval is automatic, no real User/session exists, and registration/storage/admission are not production security. Never deploy. Metadata documents are operator-supplied; arbitrary URLs are never fetched by this simulator.

```js
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { makeOAuthFixture } from "./oauth.mjs";

test("the browser exchange has a realistic access window and refresh rejects a substituted resource", async () => {
  const fixture = makeOAuthFixture({ port: 0, legacy: true });
  const issuer = String(fixture.server.url).replace(/\/$/, "");
  const resource = `${issuer}/mcp`;
  try {
    const verifier = "a".repeat(43);
    const registered = await (
      await fetch(`${issuer}/register`, {
        method: "POST",
        body: JSON.stringify({
          client_name: "probe",
          redirect_uris: ["http://127.0.0.1:9876/callback"],
        }),
      })
    ).json();
    const authorize = new URL(`${issuer}/authorize`);
    authorize.search = new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: "http://127.0.0.1:9876/callback",
      response_type: "code",
      state: "probe-state",
      resource,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    const approval = await fetch(authorize, { redirect: "manual" });
    const callback = new URL(approval.headers.get("location"));
    expect(callback.searchParams.get("iss")).toBe(issuer);
    const tokens = await (
      await fetch(`${issuer}/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: registered.client_id,
          redirect_uri: "http://127.0.0.1:9876/callback",
          code: callback.searchParams.get("code"),
          code_verifier: verifier,
          resource,
        }),
      })
    ).json();
    expect(tokens.expires_in).toBe(600);
    const refreshRequest = (resource) =>
      fetch(`${issuer}/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: registered.client_id,
          refresh_token: tokens.refresh_token,
          resource,
        }),
      });
    expect((await refreshRequest(`${issuer}/other`)).status).toBe(400);
    expect((await refreshRequest(resource)).status).toBe(200);
  } finally {
    await fixture.dispose();
  }
});
```
