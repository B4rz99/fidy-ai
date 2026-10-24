# Provider Authentication

## WhatsApp link-first onboarding — #1531 (local work, 2026-10-24)

Intended journey: message Fidy, open one short signup link, accept the browser disclosure and use
Google or Microsoft, review the account/chat association, then open Fidy WhatsApp with its confirmation
message prepared. The caller presses Send; Fidy links only after that exact message arrives from the
original authenticated chat. The initiating browser stays open with its private proof. Providers
remain required. New Users save the one-time recovery code on the original Fidy page before closing that page; existing Users retain
identity, Consent, TrialPeriod and recovery. No “Estado” command or copied association code is
required for new invitations. Existing channel links are never replaced by this flow.

The invitation is a public locator with immutable authenticated source metadata and a ten-minute
lifetime. Private browser proof, verified OIDC and exact originating-chat approval are checked again in the atomic
completion unit. An unfinished attempt may restart only in the same private browser and original
lifetime; uncertainty cannot replay completion. Expired protocol metadata has a one-day retention
limit and associated invitations participate in credential erasure. Migration
`0002_whatsapp_signup_invitations.sql` expands the existing baseline without rebuilding data tables.

Current evidence is local, not a deployed claim. The revised candidate passed all 172 native
authentication/Consent checks (including 26 focused native linking checks), 256 web unit checks and
20 Google/Microsoft built-browser journeys after synchronizing signup branding, plus 12 repeated
Google/Microsoft signup/login cancellation journeys. The earlier full native run hit local socket exhaustion;
all 12 affected files then passed in a bounded rerun: 271 checks passed, two intentionally skipped.
The full static verification group passed. Review identified and corrected a vacuous conflict test:
the second chat now sends its exact native approval before completion is refused. A controlled local
mutation removing only the initial-association guard made that test fail (completion returned 200);
the guard was restored and the focused 26-check suite passed.
That rerun exposed an external-popup cancellation assumption: Fidy had cleared `window.opener`
for isolation, but still tried to close the provider-origin window from its parent. A focused browser
regression reproduced Chromium's navigation refusal with Google as well as the earlier Microsoft
failure. Cancellation now closes only blank/first-party windows, discards local authority and tells
the User to close any remaining external provider window. Successful/denied first-party callback
pages still close themselves; no opener or isolation policy was relaxed. The focused native public/Core/D1 checks cover
first-contact non-authority, current Consent, first-claim forwarded links, wrong/missing native
approval, wrong caller/endpoint/account, pre-review messages, denial, replaced provider attempts, wrong provider/browser,
expiry, concurrency, atomic rollback, existing-User preservation and retry. The built browser uses
controlled Google/Microsoft callbacks, intercepts the fixed WhatsApp return URL and submits the prepared
message through authenticated native Ingress/Core/local D1 before expecting recovery or a session. Real provider
login, mobile/browser return behavior and live delivery still need the deployed journey.

Production baseline `a08d02a2c256a25e8837771d112b1458f81e9158` passed deployment `40093477574`
and signed full inspection `40093977215` on 2026-10-24, including D1, Queue and Workflow proof.
Those checks precede this change. The live old handoff reached verified Google authentication and
explicit chat confirmation, then safely refused an already-associated User. The User authorized a
single exact QA unlink; provider credentials, Transactions and Consent history were verified intact.
No new association is claimed complete, and the new flow has not yet been deployed or live-tested.

The unified `/login` view offers Google and Microsoft buttons in the same form. A mounted attempt captures the explicitly selected provider; cancellation, retry and completion use that same provider. The application composes channel/mailbox pairing as another step at the same URL. Fixed continuation decoding is shared by both authentication methods.

Broad non-AI audit, 2026-10-12: all 99 ordinary built-browser checks passed, including the controlled Google/Microsoft callbacks and real local pairing/session journeys. The additional onboarding/PAT/OAuth Worker/D1 run passed 303 checks. All three opt-in browser-cost checks also passed on synchronized trunk `6863b80f2a`, including provider cancellation, pairing cadence, hidden-document continuation and route-unmount cleanup. The 60-second clock-driven observations after cancellation/unmount or authentication replacement recorded no further requests. These are isolated local checks with controlled provider callbacks and clock advancement, not 60-second production wall-clock observations or real provider availability.

Production Google continuation passed again on 2026-10-12, release `9aafe8db54`: identity confirmation restored the same User's `Accesos QA bearer 20261012` review with Lectura only and seven-day duration, without issuing automatically. Explicit issuance succeeded; canonical bearer read, missing-scope refusal and revocation were verified in the Accesos audit. The test token was removed afterward. This closes the pending Google continuation for that reviewed grant; live Microsoft completion and deliberate changed-User restoration remain separate checks.

Current local audit, 2026-10-12, trunk baseline `9aafe8db54`: all 24 selected Google/Microsoft authentication, OAuth review and native Transaction-pagination browser checks passed in 1.9 minutes. Provider checks exercised signup, session persistence, recovery disclosure, denial/cancellation and WhatsApp handoff; the shared Google checks also exercised unavailable and stalled pairing, late responses, blocked popups and uncertain completion. Native providers use isolated test identities and controlled provider callbacks, so this does not establish live Microsoft-provider completion.

Google and Microsoft sign-in use the React route and its mounted private controller. The generated authentication client owns transport; the controller owns pairing proof, provider popup and one-time recovery disclosure. Disposal clears private state and aborts pending work.

Current UI coverage runs through built-browser provider/pairing journeys. The former component and application authentication suites are historical evidence. The Foldkit implementation was replaced with the preceding React implementation on 2026-10-11.

Token identity confirmation uses the closed `resume=pat` route flag with existing-account login. Both provider choices preserve the continuation. Successful authentication returns to `/settings/access?resume=pat`; there is no caller-supplied redirect URL. The PAT owner verifies the current User before consuming the bounded draft and requires another explicit issuance confirmation. Native Google and Microsoft Core/D1 browser journeys exercise the complete handoff, issuance and revocation. Production Google completion passed in the continuation below; live Microsoft completion remains pending.

Production release `804b122e7f68eec439f165b42cf99b6aedff99f1` deployed successfully on 2026-10-12. The freshness-only refusal opened the Google identity-confirmation page with `resume=pat`, same-account copy and no signup agreement. “Volver al token” restored the approved name, Lectura permission and seven-day review without issuance. Actual Google popup completion is unverified: native popup access was blocked by the locked Mac, and the User was asked to complete that step. Local native Google/Microsoft completion remains the integration evidence for the full provider round trip.

Production continuation, 2026-10-12: after the User reported unlocking and signing in, the original provider page still reported that access was not completed. Returning to Accesos loaded metadata, but the 20-minute draft had expired. Reconstructing the already approved Lectura-only seven-day `Accesos QA 20261012` review and submitting still produced the identity-confirmation prompt; no test token was issued. A new provider attempt was launched with a newly preserved form. Native computer-use access to the Codex provider popup was disallowed, so live provider completion remains an explicit User action. The stale session must not be described as refreshed.

The subsequent live Google attempt completed and returned to `/settings/access?resume=pat`. The returned page showed no active PATs and a blank creation form; Transactions showed one record rather than the audit account’s 99. This is consistent with an account change, but the account identity has not been independently confirmed. No token was issued or recreated across that boundary. The User was asked whether to return to the original audit account or explicitly authorize the same read-only test on the current account. Do not count this as successful same-User draft restoration.

The User initially chose to return to the original audit account. A fresh Google selection returned the same visible data. The User then explicitly authorized using the currently signed-in User and confirmed the exact test grant; the earlier metadata difference remains unexplained and is not proof of an identity-linking defect.

Production completion, 2026-10-12: the User completed Google identity confirmation for the explicitly approved current User. Fidy returned to the restored `Accesos QA 20261012` review with Lectura only and seven-day duration. No token was automatically issued. A separate explicit confirmation created the token, metadata persisted after reload, and individual revocation removed it from the reloaded active list. This establishes the live Google round trip and same-User draft restoration. Live Microsoft completion and deliberate changed-User restoration remain unverified.
