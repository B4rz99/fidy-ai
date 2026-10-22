# Accesos

Latest production audit, 22 October 2026: protected reads became unavailable after release
`ff37f818fbf86bc766e090dc5cba8ee746cdd80a`. The deployed standing query requires
`payment_source_context`, which is absent from production D1; read-only preparation reproduces the
missing-view error. This is confirmed code/schema mismatch evidence, not a renewed quota diagnosis.
The guarded rollback failed closed. [Incident evidence and deferred checks](../../../../../docs/operations/audit-20261022-schema-mismatch.md)
record the recovery boundary. Earlier successes below remain dated evidence; they do not establish
availability after this deployment. No further production financial or access mutation was attempted.

A fresh post-incident Accesos navigation still returned MCP metadata with all eight audit grants
marked Revocado (HTTP 200), while PAT metadata returned HTTP 503 and offered Reintentar carga.
The browser retained the signed-in session and did not ask for fresh identity merely to view it.

Current audit status, 22 October 2026, deployed release
`20fd17a37458f54031c771d0b9e1de24a5e98933`: after an intentional reload, PAT metadata
and MCP connections both returned HTTP 200 under the existing session without an identity prompt.
There were no active PATs, and all eight retained audit MCP grants displayed Revocado. This closes
the fresh production read/recovery check after D1 reset and confirms cleanup; no issuance,
permission expansion, revocation or sign-in was performed. Provider account replacement, Microsoft
completion and populated production continuation beyond twenty-five connections remain live gaps.
The local tests below do not substitute for those checks.

Current audit status, 21 October 2026: all eight audit MCP grants were revoked before the latest
database outage. The User confirmed D1 quota exhaustion; production issuance, revocation and
read-recovery checks are paused. The latest combined local Accesos/OAuth rerun passed 13 browser
checks. Temporary connection-read failures offer retry, while only the declared unauthenticated
response offers sign-in; deployment verification of that presentation remains outstanding.
Provider account replacement, Microsoft completion and populated production pagination remain
separate live checks. Earlier pending-grant entries below are superseded by the recorded cleanup.

Production D1-reset read verification, 20-10-2026 Bogotá, release
`da6dc816e10655f8b21fe13d8e61801d0f9d4c1c`: the existing session loaded the combined
Accesos page successfully before promotion. After promotion, PAT metadata remained available;
the first MCP GET was aborted without an HTTP response and the page showed its unavailable
state. Explicit Actualizar lista then returned HTTP 200 and restored the successful empty MCP
page without signing in again. No token, connection, permission or session was created or revoked.
This establishes explicit recovery from the observed transient read failure, not a proven
freshness regression or uninterrupted availability. Live Microsoft completion, intentional
changed-User restoration, external MCP planning confirmation and populated production MCP
continuation are not established by an empty metadata page.

Current-artifact identity-resumption audit, 2026-10-14, Effect 4.0.2: two new production-build browser checks seed only the bounded non-secret identity-confirmation draft and resolve the authenticated User through controlled HTTP. The same User returns to the exact name, Lectura-only permission and seven-day review without a PAT mutation. A different User receives a blank form, no review and no PAT mutation. Both checks assert that the saved draft is consumed from session storage. This closes the mounted browser handoff gap locally; it does not establish an actual production provider account switch or Microsoft popup completion.

Production read regression, 2026-10-14, release `30f585ceb1a811a97c523251ea6bd0bee13fc07f`: the existing signed-in session loaded both retained PAT metadata rows with date-only fields and a successful empty MCP page, without an identity-confirmation prompt or load error. No token or connection was created, revoked or altered. This confirms current read-only authority, not changed-account restoration, bearer use or production MCP continuation beyond 25 records.

Rebased audit, 2026-10-14, baseline `a387f50fb5`: the three combined Accesos browser checks and actual Core/D1 MCP continuation journey passed again, alongside the Dashboard title persistence journey (five checks total). This verifies responsive metadata, keyboard review/draft restoration, one-time disclosure disposal, and 26 connections without duplicates in the isolated local topology. It does not replace the outstanding production provider and changed-User checks below.

Broad non-AI audit, 2026-10-12, baseline `9aafe8db54`: the full web suite passed 449 checks, the ordinary browser run passed 99 checks, and the separate real native CLI login journey passed. A further actual Worker/D1 onboarding/PAT/OAuth run passed 303 checks (one opt-in check skipped), covering issuance, fresh-authority refusal, pairing, scopes, revocation and authentication boundaries. These counts include adjacent features rather than 852 Accesos-specific checks. The CLI browser journey verifies reviewed login, canonical query/mutation/batch execution and attributable Audit in its own local User/D1 topology. No new production access was granted during this broad rerun. Live Microsoft approval, intentional changed-User draft restoration and production MCP continuation still require suitable User participation or data; prior production PAT bearer/revocation evidence remains recorded below.

Audit regression, 2026-10-12, trunk baseline `9aafe8db54`: all five combined Accesos/native-pagination/recovery-disclosure browser checks passed in 12 seconds. Accesos checks covered desktop and narrow layout, keyboard grant review and draft editing, controlled issuance refresh and disclosure disposal, and actual isolated Core/D1 continuation through 26 MCP connections. The focused agent/PAT/OAuth/email/recovery React suite passed 54 checks. This adds current local regression evidence; it does not close the remaining production account-replacement, Microsoft, bearer-invocation or multi-page MCP checks.

The same baseline subsequently passed five OAuth review/management browser checks within a 24-check provider/OAuth/Transaction run. These exercise exact connection approval and callback exchange, cancellation without authority, forged-session and callback refusal, unavailable/malformed metadata, registration/discovery bounds, and the real local revocation/racing-refresh scenarios embedded in the approval journey. The User confirmed that the other production task had paused. A reviewed seven-day Lectura-only token named `Accesos QA bearer 20261012` was prepared for production read/write-refusal/revocation testing; issuance awaits action-time grant confirmation, and no new token was created during preparation.

Production bearer verification completed on 2026-10-12 against release `9aafe8db54`. The User completed the newly opened Google identity confirmation; Accesos restored the exact `Accesos QA bearer 20261012` name, Lectura-only permission and seven-day review without automatic issuance. Explicit confirmation created short code `0h53e55h`. A direct authenticated `GET /categories` returned 200; a valid same-title `POST /dashboard/edits` returned 403 `scope_missing`. Individual revocation succeeded, and the same bearer subsequently received 401 `unauthenticated` from `/categories`. Reloading Accesos confirmed that the test token was absent and the other task's `Dashboard QA title check` token remained untouched. The bearer was held only in test-run memory, never printed or written to disk, and cleared after verification. An initial PAT request to `/mcp` returned 401; the canonical PAT tests use the direct API endpoints, while external MCP connections use OAuth authority.

`/settings/access` combines manual PAT management and the User's external MCP connections. This is a capability and verification map, not an independent specification. Both previous settings URLs resolve to the same combined application route.

| Capability         | Actual behaviour                                                                                                                                                                                                                                       | Verification                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token metadata     | Lists active names, safe short codes, permissions, creation, last use and expiration. Dates show `dd-mm-yyyy`; unused tokens show “Nunca”.                                                                                                             | React PAT checks and combined browser layout journey.                                                                                                        |
| Manual creation    | Reviews the selected name, permissions and duration before issuing one request identity. The bearer is disclosed once in a private mounted owner; issuance refreshes the token list.                                                                   | PAT issuance, uncertain retry, copy and disposal checks; combined-page browser issuance and navigation journey.                                              |
| Token revocation   | Individual/all selection requires explicit confirmation. A failed mutation remains uncertain until a fresh read; stale metadata disables another revocation.                                                                                           | PAT rendered interaction checks. Real local Core coverage belongs to the token owner and CLI pairing journeys.                                               |
| MCP metadata       | An ordinary live WebSession reads one canonical page of up to 25 connections, showing declared name as escaped text, state, permissions and expiration. UUIDs and detailed activity are omitted from visible copy.                                     | OAuth rendered interaction checks; combined browser table/layout journey; native OAuth browser journey.                                                      |
| MCP continuation   | Public `after` references select the next page; first-page and next-page controls stay within Accesos. Invalid public references fail route decoding.                                                                                                  | Canonical route/OAuth checks and a real local Core/D1 browser journey through 26 metadata-only connections, with no duplicates and return to page one.       |
| MCP revocation     | A fresh WebSession revokes one canonical connection or all connections. Follow-up reads update evidence; uncertain mutations require explicit refresh and cannot replay through another revocation click.                                              | OAuth unit checks and real local public Ingress/Core browser scenarios, including cross-User, CSRF, refresh-token races and bearer refusal after revocation. |
| Failure and layout | Unavailable evidence remains distinct from empty evidence. Tables scroll inside narrow containers. The desktop creation rail fills the available vertical space.                                                                                       | Combined 1366px/390px browser journeys, narrow keyboard review/draft restoration, and unavailable/malformed OAuth checks.                                    |
| Scope              | Route removal disposes all three child owners; authentication disposal releases the page. Late mount admission and repeated disposal are guarded. PAT disclosure remains in mounted React state and never enters shared atoms, browser storage or URL. | Private controller disposal checks and combined navigation journey. Production account replacement on the current combined artifact remains outstanding.     |

## Owners

- `app/access-page.tsx` composes the combined React page; `app/routes.ts` owns routing.
- `pats/feature.tsx` owns canonical token reads and mutation commands; `view.tsx` owns reviewed issuance and private one-time disclosure. `reauthentication-draft.ts` bounds the non-secret same-User handoff.
- `oauth-connections/feature.tsx` owns MCP listing and revocation. Combining the presentation does not combine PAT and OAuth authority.
- The server's Tokens and OAuth Agents publications remain the sole API contracts. `/connect/cli` is the separate PATPairing authorization surface; Accesos has no generic code-entry flow.

## Evidence and remaining checks

Audit resumed on 2026-10-11 from Foldkit trunk revision `8ce7fd176d98968250b080c8b8f06e5ef24d37f7`. The earlier uncommitted React audit and UI work is preserved in Git stash rather than applied over the migration. The combined page was merged in PR #1228 as revision `d1a1151efb38776ea3c11b257a9db989e3592d5c`, after all CI checks passed. Full Foldkit web coverage passed 615 tests with 90.00% branch coverage. The React restoration carries the combined page forward using the saved pre-migration React owners; earlier Foldkit verification is historical evidence for that artifact.

61 PAT/OAuth/route unit checks passed. Both combined-page browser journeys and five native OAuth browser journeys passed. Controlled-response browser journeys establish combined rendering, issuance refresh and disclosure disposal, but do not establish live Production persistence. The native OAuth journey uses the real local public Ingress/Core/D1 topology and synthetic loopback identity approval; it does not use Production identities or credentials.

Additional local audit on 2026-10-11: the real public Ingress/Core/D1 browser journey returned 25 MCP connections, then the final connection without duplicate identities, and returned to page one within Accesos. The independent fixture seeds metadata only, with no usable OAuth grant or bearer; it proves listing continuation, while native OAuth approval/revocation journeys establish authority separately. A 390px keyboard journey verified name entry, scope toggling, duration selection, review activation and restoration of the edited draft.

Production release `d1a1151efb38776ea3c11b257a9db989e3592d5c` deployed successfully on 2026-10-11. The signed-in browser displayed the combined Accesos page and actual PAT metadata with date-only formatting. MCP listing unnecessarily refused the older live WebSession and offered fresh sign-in. This read-only freshness bug was fixed in PR #1232. The earlier release deferred Workers AI conformance for exhausted quota without blocking deployment.

Remaining live checks: current-artifact account replacement. Deployed combined-page PAT issuance/revocation passed in the production continuation below. Production continuation past 25 connections requires suitable existing data; local fixture evidence does not establish it. Workers AI availability is not required for these operations. Do not mark them as passed from fixtures, older deployments, or provider quota reset.

Latest focused verification, 2026-10-14: all 11 built-browser checks across `access-management.spec.ts`, `access-native-pagination.spec.ts` and `budgets.spec.ts` passed in 1.3 minutes on Effect 4.0.2. This includes actual local Core/D1 cap persistence and 26-connection continuation, alongside controlled browser recovery and identity-handoff checks. All six PAT draft/exact-Money unit checks passed. Web type checking and ordinary/type-aware lint for the changed browser specs passed. No new production token, MCP connection or Budget cap was created during this continuation.

## Rerun

```sh
bun run --cwd apps/web test src/features/pats/reauthentication-draft.test.ts
bun run --cwd apps/web test:browser access-management.spec.ts access-native-pagination.spec.ts oauth-review.spec.ts --workers=1
```

On 2026-10-12 the MCP read boundary was changed to require a live session, while individual and aggregate revocation retain fresh-session admission and commit-time guards. All 15 Worker/D1 management tests passed, including the freshness-expired read, both mutation refusals, and revoked-session read refusal. All four combined-access browser checks and five native OAuth browser journeys passed with the updated dependency pins.

PR #1232 merged as `429722121aa03f05ff6550cf58833c463a96ff92`, and [production deployment 38265874719](https://github.com/B4rz99/fidy-ai/actions/runs/38265874719) passed. The public deployment metadata reported that revision. Reloading the same existing production browser session, without signing in again, displayed actual PAT metadata and a successful empty MCP result (“No hay conexiones en esta página.”), with no error alert or sign-in prompt. Before deployment the same session displayed a MCP read failure. This proves the live read-only freshness fix; it does not establish production grant creation, revocation, account replacement or multi-page MCP continuation.

The User approved a seven-day, Lectura-only production token named `Accesos QA 20261012`. Submission using the older session was refused and the frontend displayed “Sesión vencida”. Returning to Accesos with the same cookie still loaded the existing two PATs and successful MCP evidence; no test token was listed. This establishes live refusal of creation without recent authentication, while confirming ordinary read authority remains valid. The expired-session copy and disposal were misleading for a freshness-only refusal. Issue #1234 implements a distinct identity-confirmation handoff; deployment verification remains pending. Existing-account Google reauthentication reported “Cancelaste el acceso”; successful issuance/revocation therefore awaits the User's fresh sign-in, with grant approval already recorded.

Identity-confirmation audit, 2026-10-12: manual issuance now distinguishes a live session requiring recent authentication (403 `reauthentication_required`) from an expired or revoked session (401). The former retains the mounted form and offers “Confirmar mi identidad”. An explicit click stores only the selected name, permissions and duration in tab-scoped session storage for at most 20 minutes. Google or Microsoft existing-account sign-in returns to Accesos. The authenticated User must match the saved User; invalid, expired or changed-account drafts are discarded. Restoration returns to review with a newly calculated expiry and request identity; it never creates a token automatically. No bearer or pairing proof enters storage.

The native Core/D1 Google and Microsoft browser journeys cover refusal, identity confirmation, restored seven-day review, explicit issuance and revocation. Rendered combined-page checks include same-User and changed-User restoration under React Strict Mode. These establish local integration behaviour, not successful production provider sign-in. The approved production test token remains pending that live verification.

PR #1235 merged as `804b122e7f68eec439f165b42cf99b6aedff99f1`; [production deployment 38276325280](https://github.com/B4rz99/fidy-ai/actions/runs/38276325280) passed, and public deployment metadata reported that revision. With the existing live session, submitting the approved Lectura-only seven-day `Accesos QA 20261012` displayed “Confirma tu identidad” while ordinary metadata remained available. The explicit identity button opened `/auth/google?resume=pat`. Returning through “Volver al token” restored the exact name, Lectura permission and seven-day duration to review, recalculated the expiry, and did not issue a token. Resubmission with the still-stale session correctly required identity confirmation again. This establishes live refusal classification, preservation, restoration and no automatic issuance; successful provider completion and subsequent issuance/revocation remain pending. Google sign-in was launched, but native popup access was blocked because the Mac was locked; the User was asked to unlock and complete same-account confirmation.

Production continuation, 2026-10-12: after the User reported unlocking and signing in, the original provider page still reported that access was not completed. Returning to Accesos loaded metadata, but the 20-minute draft had expired. Reconstructing the already approved Lectura-only seven-day `Accesos QA 20261012` review and submitting still produced the identity-confirmation prompt; no test token was issued. A new provider attempt was launched with a newly preserved form. Native computer-use access to the Codex provider popup was disallowed, so live provider completion remains an explicit User action. The stale session must not be described as refreshed.

The subsequent live Google attempt completed and returned to `/settings/access?resume=pat`. The returned page showed no active PATs and a blank creation form; Transactions showed one record rather than the audit account’s 99. This is consistent with an account change, but the account identity has not been independently confirmed. No token was issued or recreated across that boundary. The User was asked whether to return to the original audit account or explicitly authorize the same read-only test on the current account. Do not count this as successful same-User draft restoration.

The User initially chose to return to the original audit account. A fresh Google selection returned the same visible data. The User then explicitly authorized using the currently signed-in User and confirmed the exact test grant; the earlier metadata difference remains unexplained and is not proof of an identity-linking defect.

Production completion, 2026-10-12: on the explicitly approved current User, submitting `Accesos QA 20261012` with Lectura only and seven-day duration required identity confirmation without issuing a token. The User completed the Google popup. Accesos restored the exact name, permission and duration to review, with a recalculated expiry and no automatic issuance. Explicit confirmation created the token; safe metadata remained present after a reload with creation date `12-10-2026`, expiration `19-10-2026` and last use “Nunca”. The one-time disclosure was disposed through “Crear otro token” without copying or recording its bearer. Individual revocation succeeded, and a subsequent reload returned no active tokens. This establishes the live Google same-User preservation, explicit issuance, metadata persistence and individual revocation journey. Bearer-based canonical invocation, live Microsoft completion, changed-User restoration and MCP continuation beyond 25 connections are not established by this observation.

## Manual issuance ownership

External-client continuation, 2026-10-20 Bogotá, release
`ce8c9b51f096e8a93e601af7fd9db595bc3589ff`: MCP Inspector 2.10.1 discovered both OAuth metadata
documents successfully but its registration returned HTTP 400 `invalid_client_metadata` before
browser review. Its standard `client_uri` field hit the registration parser's excess-field rejection.
The Worker/D1 regression reproduces the 400 and requires 201 with only supported metadata retained
and no OAuth connection created. The fix discards unsupported registration metadata, retaining
strict validation of supported fields and browser decisions. Live registration and external planning
confirmation still require the follow-up deployment and explicit access approval; no grant was issued
during this failure. Kapso currently exposes one sandbox number; the five most recent conversations
were ended, so a live WhatsApp planning check requires an active handset test conversation.
The complete OAuth Worker/D1 rerun passed 224 checks with one optional native-host bridge skipped.
The initial parallel run encountered local `EADDRNOTAVAIL` failures; the serial rerun passed all
twelve files without changing their assertions.

`creation.tsx` owns the mounted manual PAT flow and same-User draft continuation. Its private
`issuance.ts` implementation owns review, request identity, canonical outcomes, explicit retry,
identity handoff and disclosure cleanup. `view.tsx` receives display state and User actions;
request identities and outcome callbacks do not enter presentation. Canonical command results
remain void so bearer material cannot enter Atom caches. Late completion after page departure,
page hide or authentication replacement cannot reopen disclosure.

The removed `issuance.test.tsx` suite supplied historical rendered evidence for restoration,
explicit retry identity, storage refusal, late completion and disclosure cleanup. Current storage
decisions are exercised in `reauthentication-draft.test.ts`; mounted workflows use browser journeys.
Metadata listing/revocation and CLI pairing retain their independent ownership. Existing storage,
clipboard, combined-page and native provider browser journeys remain applicable.

Production external-client audit, 20 October 2026, release `eb9374c92dd97a63f45a6a108a8660b0cfe39842`:
Google sign-in and the explicitly approved seven-day MCP Inspector grant completed with Lectura and
Escritura, excluding Tablero. Accesos displayed the active connection and the external client read
canonical recurring state. Later revocation exposed a distinct freshness bug: 401 disposed Accesos,
but reloading with the same cookie restored metadata. The test grant remains pending verified
revocation and subsequent external access/refresh refusal; starting a provider popup did not refresh
identity without its completion.

Issue #1422 changes individual and aggregate MCP revocation to distinguish a live session needing
identity confirmation (declared 403 `reauthentication_required`) from an invalid/revoked session
(401). Accesos retains metadata and offers an explicit identity-confirmation link returning to this
page. Return never replays a mutation: the User must select the agent again. Origin, binding,
consent, ownership and atomic freshness guards remain enforced. Worker/D1 regression coverage checks
both refusals without revocation; the built-browser regression checks retained Accesos, the fixed
identity destination and no replay. Production verification of this follow-up is pending deployment.

Production continuation, 21 October 2026, release `d50938e433193ba07e0207f0193f4f8881526f5a`:
the User completed the fresh Google identity popup from `/login?resume=access` and returned to
the same Accesos account. No revocation was replayed automatically. Explicitly selecting the
existing MCP Inspector connection then displayed the server-confirmed revocation message and
changed its state from Activo to Revocado. The client could not reconnect with its retained
credentials: it required a new OAuth authorization. That replacement request was explicitly
cancelled without granting access; Inspector remained disconnected and displayed
`Re-authentication required`. This closes live identity-return and original test-grant cleanup.
It does not independently establish the exact refresh-token error response or successful MCP
mutation confirmation. A later proposed seven-day retest is separate authority and requires
its own action-time approval.

The separately approved 21 October retest grant was issued after Google identity completion,
then explicitly revoked after the native confirmation test stalled. Accesos showed both Inspector
grants as Revocado. Reconnection required new authorization and did not restore tool access.
This closes cleanup for both grants; the external mutation result remains unverified.

The separately approved traced test also completed seven-day read/write issuance after the expired
OAuth request was renewed. Its Google identity completion was reused successfully. After capturing
the stalled decline transport, explicit revocation succeeded before freshness expired. All three
Inspector connection rows displayed Revocado. No additional production access remains from these
Inspector tests.

Supported Codex continuation, 21 October 2026, same deployed release: after same-account Google
identity confirmation, a fresh native authorization request reused the User's explicit replacement
approval. The reviewed read/write scopes and seven-day duration were issued successfully and
Codex completed its localhost callback. Its cancellation-only recurring test completed. Immediate
individual revocation displayed the success message and changed the new Codex row to Revocado;
all five audit connection rows were revoked. Native logout removed the isolated client's stored
OAuth credentials. No retained-credential reconnect was attempted for this grant, so this run
does not independently prove its refresh-token refusal. Expired CLI callbacks were renewed before
grant creation; they were not treated as successful authorization.

Claude Code preparation, 21 October: the pinned native client completed automatic localhost OAuth
against a disposable local provider, and local logout cleared that test credential. The audit
runner now recognizes successful native callback completion without requiring a pasted callback
file; failure and missing-authorization cases remain rejected. These tooling checks do not issue
production access.

Production Claude Code continuation, 21 October, same release: Google identity confirmation
returned to the exact pending review. The separately approved read/write grant used seven days;
the pinned client completed its native localhost callback and the cancellation-only test passed.
Immediate individual revocation displayed the successful revocation message and changed
`Claude Code (fidy)` to Revocado. All six audit connection rows were revoked, and native logout
cleared the isolated credential. No reconnect/refresh refusal was captured for this new grant.

Inspector timing comparison, 21 October 2026: the User separately approved another read/write
connection for seven days, solely for synthetic recurring cancellation. The client was disconnected
and its isolated diagnostic process stopped after the comparison. Individual revocation returned
`reauthentication_required` and displayed the identity-confirmation link without losing the access
list. This newest grant remains active pending same-account provider completion and explicit
revocation. The prior six audit rows remain revoked; their cleanup does not cover this new grant.

Cleanup continuation, 21 October 2026: after the User completed the same-account Google popup,
a page refresh restored the authenticated Accesos list. Explicit individual revocation of the
newest Inspector connection returned “Acceso revocado. Las acciones ya realizadas se conservan.”
and changed its state to Revocado. All seven audit connection rows were then revoked. This
closes the pending cleanup above; it does not resolve the Inspector cancellation failure.

Inspector dispatch follow-up, 21 October: a corrected local baseline reproduces the cancellation
POST queue with Node 26.5.0's bundled dispatcher. The isolated Inspector launcher using pinned
Undici 8.12.3 passes cancellation-only and concurrent-read HTTP/2 tests with normal TLS verification.
The original nominal bundled baseline had imported external Undici first and was invalid. Fidy's
legacy integration separately retains data and returns `user_action_required` for delayed cancel
and decline. Production UI semantics remain pending a separately approved rerun; the earlier
HTTP/1.1 `unavailable` result is not a pass. All prior audit grants remain revoked.

The follow-up uses policy-eligible Inspector 2.11.0, MCP client 2.3.1 and Undici 8.12.3 in an
isolated development tool. Both baseline cases still fail without its preload; both pass with it.
The actual Inspector web UI also connected to a disposable local TLS HTTP/2 server, displayed the
native form, and completed Cancel with `user_action_required` (about four seconds including the
manual click). No production access was created by this local test. The full OAuth/MCP adapter
suite passed 227 tests with one existing skip; TypeScript, ordinary/type-aware lint, dependency
policy (zero failures) and both transport regressions passed. The npm bulk advisory endpoint
reported no advisories for the isolated tool's 118 installed package names. Workspace Gate runs
the new transport regressions on CI; production verification remains a distinct pending step.

Corrected Inspector production closure, 21 October 2026, 16:19–16:22 UTC: same-account sign-in
returned to the prepared review. The User-approved new read/write connection used seven days;
Inspector 2.11.0 with the isolated Undici dispatcher completed OAuth and its cancellation-only
test passed. Immediate explicit individual revocation returned the server success message and
changed the new row to Revocado; all eight audit connection rows were revoked. The disconnected
Inspector process was stopped and its local revoked-credential state removed. No retained-token
reconnect was attempted for this grant, so this run does not independently prove refresh refusal.

Post-deployment regression, 21-10-2026, release `f2c42e319a`: ordinary signed-in reads of `/pats`
and `/web/oauth/connections` returned HTTP 503, including explicit UI retries. The PAT response
reported the closed code `unavailable` (trace `e8ebb72ccd0fea4d2403b7e8a1f99557`); the connections
trace was `1f0b71fb44f6dad492b70ac92842b918`. Background `/ingestion/review-workspace` also returned
503, while Dashboard, Budgets and Recurrentes rendered previously loaded data. The User was notified because a D1 change
was being deployed. Read-only schema inspection found every checked-in schema object present;
that does not establish the cause of these failures. No new grant or access mutation was attempted,
and current list visibility remains an open production regression.

Read-only D1 query analytics in a 12-hour window wholly within 21 October reported at least
171,324 rows written across its five largest query groups; 146,676 were attributed to `ALTER`
operations. This exceeds the documented Free-plan daily 100,000-row write allowance and supports
quota exhaustion following schema work as a hypothesis. Analytics is not the closed provider
failure for an individual request, so the 503 root cause remains unconfirmed. Metadata queries
and read-only `EXPLAIN` compilation succeeded; no direct production data/schema write was used
to diagnose it. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

The same Production 503 also exposed misleading recovery copy: the MCP list offered sign-in
for every read failure. A controlled built-browser 503 regression reproduced that prompt and now
passes after classifying only the declared `OAuthUnauthenticated` error as requiring sign-in.
Temporary and boundary failures retain explicit list retry without suggesting identity renewal;
a separate 401 regression preserves sign-in recovery. The existing public error schema is reused
through the browser client boundary, with no endpoint or authorization-policy change. All seven
Accesos browser journeys pass locally, including retry restoring MCP metadata beside retained PAT
metadata. This presentation fix does not establish that the underlying Production 503 is resolved.

A subsequent uncached November read returned HTTP 503 from `/recurring-plans` (trace
`a4360d682e28cbd319419680a4cd7450`), with the correct error state rather than a false empty
workspace. `/ingestion/review-workspace` also returned 503 (trace
`15127635bd02bdf4ff389137a094249f`). The earlier populated October view was retained browser
state and is not evidence of current backend availability. Live financial/access mutations
remain paused; fresh recurring reads and the post-deployment hosted lookup rerun are blocked.
