# Bancolombia authorization preparation — #1267

Assessment 2026-10-19. [#1267](https://github.com/B4rz99/fidy-ai/issues/1267) requires a complete
validated bank handoff; this note identifies reusable preparation already present, not completion
of the bank flow. The [#1266 profile worksheet](bancolombia-profile-1266.md) owns unresolved accepted
client/issuer, PAR/token/consent contract, scopes and mTLS requirements. Keep the production gate disabled.

## Existing independent controls

The existing Connections owner publishes browser continuation admission/preparation. Its native
`apps/server/cloudflare/connections/connections.test.ts` suite exercises the public/Core HTTP seam
against isolated D1 bindings, not a fabricated Bancolombia authorization server.

| Control                         | Existing focused behavior                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same-User session authority     | Another User holding the public locator cannot review or begin that continuation. A public reference alone does not authenticate.                                          |
| Freshness and original lifetime | Expired attempts, stale/revoked sessions and disabled institution admission are refused; exact expiry produces a fresh attempt while retaining stable Connection identity. |
| Origin and input admission      | Hostile browser inputs/origins are refused before consuming a valid attempt; ordinary shared request/Audit pressure applies.                                               |
| Consent/session races           | Preparation rechecks authority at its durable commit when a session is revoked or Consent withdrawn.                                                                       |
| Single use and concurrency      | One concurrent preparation wins; repeat preparation does not activate the Connection or invent a bank request.                                                             |
| Atomic evidence                 | Audit failure rolls back preparation and permits a safe retry; cross-User isolation and expiry/retention preserve owning boundaries.                                       |
| Truthful state                  | A prepared execution remains Connecting. Neither the existing browser preparation nor the registration callback claims successful bank authorization or Active state.      |

These controls should be reused by the bank continuation, not replaced by a second attempt/session
system. Source inspection is distinct from a passing test; record the actual suite result and exact
revision with the implementation evidence. This assessment itself starts no public browser flow.

## Work that still needs accepted bank semantics

Matching private signing-key possession remains unverified. The published JWKS and protected
secret metadata alone do not prove it; the profile worksheet retains that distinction.

PKCE/S256 has a public standards definition, but its integration still needs the accepted request
fields and lifecycle. Do not add a detached helper or a second state store solely to make an empty
slice look complete. The substantive next #1267 slice must bind accepted consent/PAR fields,
PKCE verifier, state/nonce and signing to the exact existing attempt, with durable claiming and
settlement around bounded bank calls. It needs the confirmed issuer/destinations, transport,
permissions, retry/uncertain-outcome rules and assertion policy from #1266. A guessed test response
cannot prove that contract or remove the dependency.

No new bank execution is enabled by this assessment. Remaining #1267 work includes validated
discovery/destinations, private Core signing, accepted transport, consent/PAR execution, safe
uncertain-result handling and the full built-browser handoff/negative acceptance seam. Existing
preparation tests cover only their stated boundary.
