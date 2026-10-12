# Accesos

`/settings/access` combines manual PAT management and the User's external MCP connections. This is a capability and verification map, not an independent specification. Both previous settings URLs resolve to the same combined application route.

| Capability         | Actual behaviour                                                                                                                                                                                                                                        | Verification                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token metadata     | Lists active names, safe short codes, permissions, creation, last use and expiration. Dates show `dd-mm-yyyy`; unused tokens show “Nunca”.                                                                                                              | React PAT checks and combined browser layout journey.                                                                                                        |
| Manual creation    | Reviews the selected name, permissions and duration before issuing one request identity. The bearer is disclosed once in a private mounted owner; issuance refreshes the token list.                                                                    | PAT issuance, uncertain retry, copy and disposal checks; combined-page browser issuance and navigation journey.                                              |
| Token revocation   | Individual/all selection requires explicit confirmation. A failed mutation remains uncertain until a fresh read; stale metadata disables another revocation.                                                                                            | PAT rendered interaction checks. Real local Core coverage belongs to the token owner and CLI pairing journeys.                                               |
| MCP metadata       | Reads one canonical page of up to 25 connections, showing declared name as escaped text, state, permissions and expiration. UUIDs and detailed activity are omitted from visible copy.                                                                  | OAuth rendered interaction checks; combined browser table/layout journey; native OAuth browser journey.                                                      |
| MCP continuation   | Public `after` references select the next page; first-page and next-page links stay within Accesos. Invalid public references fail route decoding.                                                                                                      | Canonical route and OAuth pagination checks. A populated 26-connection native browser journey remains outstanding.                                           |
| MCP revocation     | Revokes one canonical connection or all connections. Follow-up reads update evidence; uncertain mutations require explicit refresh and cannot replay through another revocation click.                                                                  | OAuth unit checks and real local public Ingress/Core browser scenarios, including cross-User, CSRF, refresh-token races and bearer refusal after revocation. |
| Failure and layout | Unavailable evidence remains distinct from empty evidence. Tables scroll inside narrow containers. The desktop creation rail fills the available vertical space.                                                                                        | Combined 1366px/390px browser journey and unavailable/malformed OAuth checks.                                                                                |
| Scope              | Route removal disposes all three child owners; authentication disposal releases the page. Late mount admission and repeated disposal are guarded. PAT disclosure remains in mounted React state and never enters shared atoms,, browser storage or URL. | Private controller disposal checks and combined navigation journey. Production account replacement on the current combined artifact remains outstanding.     |

## Owners

- `app/access-page.tsx` composes independent React owners; `app/routes.ts` and `signed-in/feature.tsx` own routing and navigation.
- `pats/feature.tsx` owns canonical token reads, revocation and issuance; `view.tsx` confines the one-time bearer disclosure to the mounted view.
- `oauth-connections/management-feature.tsx` owns MCP listing and revocation. Combining the presentation does not combine PAT and OAuth authority.
- The server's Tokens and OAuth Agents publications remain the sole API contracts. `/connect/cli` is the separate PATPairing authorization surface; Accesos has no generic code-entry flow.

## Evidence and remaining checks

Audit resumed on 2026-10-11 from Foldkit trunk revision `8ce7fd176d98968250b080c8b8f06e5ef24d37f7`. The earlier uncommitted React audit and UI work is preserved in Git stash rather than applied over the migration. The React restoration on 2026-10-11 carries the combined page forward using the saved pre-migration React owners. Earlier Foldkit verification below is historical evidence; it does not verify this restored artifact.

61 PAT/OAuth/route unit checks passed. Both combined-page browser journeys and five native OAuth browser journeys passed. Controlled-response browser journeys establish combined rendering, issuance refresh and disclosure disposal, but do not establish live Production persistence. The native OAuth journey uses the real local public Ingress/Core/D1 topology and synthetic loopback identity approval; it does not use Production identities or credentials.

Remaining live checks: deployed combined-page PAT issuance/revocation on an approved test User, populated MCP continuation past 25 records, current-artifact account replacement, and narrow-screen keyboard interaction. Workers AI availability is not required for these operations. Do not mark them as passed from fixtures, older deployments, or provider quota reset.

## Rerun

```sh
bun run --cwd apps/web test src/features/pats src/features/oauth-connections src/app/access-page.test.tsx
bun run --cwd apps/web test:browser access-management.spec.ts oauth-review.spec.ts --workers=1
```
