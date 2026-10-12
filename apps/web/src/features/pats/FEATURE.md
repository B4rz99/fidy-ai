# Accesos

`/settings/access` combines manual PAT management and the User's external MCP connections. This is a capability and verification map, not an independent specification. Both previous settings URLs resolve to the same combined application route.

| Capability         | Actual behaviour                                                                                                                                                                                                       | Verification                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token metadata     | Lists active names, safe short codes, permissions, creation, last use and expiration. Dates show `dd-mm-yyyy`; unused tokens show “Nunca”.                                                                             | Foldkit PAT checks and combined browser layout journey.                                                                                                      |
| Manual creation    | Reviews the selected name, permissions and duration before issuing one request identity. The bearer is disclosed once in a private mounted owner; issuance refreshes the token list.                                   | PAT issuance, uncertain retry, copy and disposal checks; combined-page browser issuance and navigation journey.                                              |
| Token revocation   | Individual/all selection requires explicit confirmation. A failed mutation remains uncertain until a fresh read; stale metadata disables another revocation.                                                           | PAT mounted-program checks. Real local Core coverage belongs to the token owner and CLI pairing journeys.                                                    |
| MCP metadata       | An ordinary live WebSession reads one canonical page of up to 25 connections, showing declared name as escaped text, state, permissions and expiration. UUIDs and detailed activity are omitted from visible copy.     | OAuth mounted-program checks; combined browser table/layout journey; native OAuth browser journey.                                                           |
| MCP continuation   | Public `after` references select the next page; first-page and next-page links stay within Accesos. Invalid public references fail route decoding.                                                                     | Canonical route/OAuth checks and a real local Core/D1 browser journey through 26 metadata-only connections, with no duplicates and return to page one.       |
| MCP revocation     | A fresh WebSession revokes one canonical connection or all connections. Follow-up reads update evidence; uncertain mutations require explicit refresh and cannot replay through another revocation click.              | OAuth unit checks and real local public Ingress/Core browser scenarios, including cross-User, CSRF, refresh-token races and bearer refusal after revocation. |
| Failure and layout | Unavailable evidence remains distinct from empty evidence. Tables scroll inside narrow containers. The desktop creation rail fills the available vertical space.                                                       | Combined 1366px/390px browser journeys, narrow keyboard review/draft restoration, and unavailable/malformed OAuth checks.                                    |
| Scope              | Route removal disposes all three child owners; authentication disposal releases the page. Late mount admission and repeated disposal are guarded. PAT disclosure never enters a Foldkit Model, browser storage or URL. | Private controller disposal checks and combined navigation journey. Production account replacement on the current combined artifact remains outstanding.     |

## Owners

- `app/native-access.ts` composes the page and owns child mount admission/disposal; `app/native-routes.ts` and `native-view.ts` own routing and navigation.
- `pats/management-program.ts` owns canonical token reads and revocation, while `manual-program.ts` and `manual-disclosure.ts` own reviewed issuance and private one-time disclosure.
- `oauth-connections/management-program.ts` owns MCP listing and revocation. Combining the presentation does not combine PAT and OAuth authority.
- The server's Tokens and OAuth Agents publications remain the sole API contracts. `/connect/cli` is the separate PATPairing authorization surface; Accesos has no generic code-entry flow.

## Evidence and remaining checks

Audit resumed on 2026-10-11 from Foldkit trunk revision `8ce7fd176d98968250b080c8b8f06e5ef24d37f7`. The earlier uncommitted React audit and UI work is preserved in Git stash rather than applied over the migration. The combined page was merged in PR #1228 as revision `d1a1151efb38776ea3c11b257a9db989e3592d5c`, after all CI checks passed. Full web coverage passed 615 tests with 90.00% branch coverage.

61 PAT/OAuth/route unit checks passed. Both combined-page browser journeys and five native OAuth browser journeys passed. Controlled-response browser journeys establish combined rendering, issuance refresh and disclosure disposal, but do not establish live Production persistence. The native OAuth journey uses the real local public Ingress/Core/D1 topology and synthetic loopback identity approval; it does not use Production identities or credentials.

Additional local audit on 2026-10-11: the real public Ingress/Core/D1 browser journey returned 25 MCP connections, then the final connection without duplicate identities, and returned to page one within Accesos. The independent fixture seeds metadata only, with no usable OAuth grant or bearer; it proves listing continuation, while native OAuth approval/revocation journeys establish authority separately. A 390px keyboard journey verified name entry, scope toggling, duration selection, review activation and restoration of the edited draft.

Production release `d1a1151efb38776ea3c11b257a9db989e3592d5c` deployed successfully on 2026-10-11. The signed-in browser displayed the combined Accesos page and actual PAT metadata with date-only formatting. MCP listing correctly refused the older WebSession and offered fresh sign-in; this is not evidence of a successful MCP read. The release deferred Workers AI conformance for exhausted quota without blocking deployment.

Remaining live checks: deployed combined-page PAT issuance/revocation on an approved test User and current-artifact account replacement. Production continuation past 25 connections requires suitable existing data; local fixture evidence does not establish it. Workers AI availability is not required for these operations. Do not mark them as passed from fixtures, older deployments, or provider quota reset.

## Rerun

```sh
bun run --cwd apps/web test src/features/pats src/features/oauth-connections src/app/native-routes.test.ts
bun run --cwd apps/web test:browser access-management.spec.ts access-native-pagination.spec.ts oauth-review.spec.ts --workers=1
```

On 2026-10-12 the MCP read boundary was changed to require a live session, while individual and aggregate revocation retain fresh-session admission and commit-time guards. Worker/D1 regression coverage checks the freshness-expired read, both mutation refusals, and revoked-session read refusal. Deployment and live verification of this change remain pending.
