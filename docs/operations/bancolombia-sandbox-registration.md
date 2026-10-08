# Bancolombia sandbox registration

This is the registration prerequisite for #305, not an executable bank authorization flow.
Sandbox access and production eligibility remain separate; the Bancolombia institution gate stays
disabled.

After the reviewed revision reaches Production through the ordinary GitHub Actions release, use:

| Form field                | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| Ambiente                  | Sandbox                                                            |
| Caso de uso               | Accounts Information - AISP                                        |
| Endpoint JWKS             | `https://api.fidyapp.com/connections/bancolombia/sandbox/jwks`     |
| URL de redireccionamiento | `https://api.fidyapp.com/connections/bancolombia/sandbox/callback` |

Verify both addresses on the deployed revision before submitting the request. The JWKS must return
HTTP 200 and one public RSA signing key with `alg: RS256`, `use: sig`, a stable `kid`, and a modulus
of at least 2048 bits. This registration uses a 3072-bit key. Only public verification material
belongs in source or the access request. Bancolombia's [JWKS guide](https://soportedevs.bancolombia.com/hc/es-419/articles/29377200410516--Que-es-JWKS)
and [Open Banking authentication guide](https://soportedevs.bancolombia.com/hc/es-419/sections/29354404515476--C%C3%B3mo-consumir-los-productos-API-de-Open-Banking)
describe the key and matching `kid` used by RS256 private-key JWT authentication.

The matching PKCS#8 private key was generated locally into the Git-ignored
`.env.bancolombia.local`, with owner-only permissions (`0600`), under
`BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM`. With the operator's explicit authorization, the same key was
also saved as that named secret in the repository's protected GitHub `production` environment.
Keep the local copy only while operator sandbox work requires it; ignored files are not preserved
when the worktree is archived. Never paste the key into the portal, chat, source, logs or a command argument.
The public Worker needs no private-key binding. A later private Core signing adapter must use the
matching key through a redacted secret binding; this registration does not install that adapter.
Do not regenerate the key during builds or releases. Changing the published key requires a
coordinated bank registration change and preservation of the corresponding private key.

The callback is deliberately unavailable until #305 installs the verified institution protocol.
GET requests containing query parameters receive a no-store/no-referrer 303 to the same fixed
callback path without parameters. The clean callback returns HTTP 503 and a static explanation.
It neither exchanges codes nor forwards to Core, records User data, creates Accounts or activates
a Connection. It cannot yet validate a real authorization attempt. If Bancolombia requires a
successful authorization round trip before provisioning, this registration alone is insufficient.

Both routes use the existing ingress origin and security-header policy. Only GET is accepted.
Existing metadata-only Worker Work observations cover latency and response outcome; no URL,
query, body or callback values enter application telemetry. Automatic invocation logs remain
disabled by the existing topology. Edge logging and tail consumers must also exclude callback
query strings before real bank authorization use.

Once access is provisioned, verify the sandbox issuer/discovery, exact redirect registration,
client authentication, mTLS certificate requirements, PAR, S256 PKCE, consent and Account
Information responses before implementing the remaining #305 behavior. A JWKS key does not replace
an mTLS certificate. Keep the production eligibility gate disabled until its independent evidence
is complete.
