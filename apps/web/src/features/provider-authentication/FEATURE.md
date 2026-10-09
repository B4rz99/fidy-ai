# Signup and browser login

Google and Microsoft authenticate a ProviderCredential by issuer/subject. Contact email never
merges Users or establishes mailbox authority. Onboarding atomically creates the User, Consent,
168-hour TrialPeriod and digest-only BackupRecoveryCode. Browser Login alone issues WebSession
after approval and proof of the initiating browser's private verifier.

| Action                                                              | Code and runtime                                                                                                                    | Verification                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Public signup and returning login                                   | This feature, `/auth/google`, `/auth/microsoft` → public Ingress → private Core Provider Authentication → D1                        | Real Google and Microsoft personal signup/returning login pass; Microsoft work/school live checks pending                  |
| Consent and one-time recovery acknowledgement                       | `/web/providers/disclosure`, provider start/completion; Onboarding                                                                  | Atomic creation/rollback, concurrent completion, same-contact isolation and lost-response non-redisclosure covered locally |
| WhatsApp-led signup and initial linking                             | Kapso authenticated Portfolio/BSUID → Consent handoff → provider browser → exact originating-message association approval           | New and existing User journeys pass for both providers; real Kapso delivery/reply pending                                  |
| Existing WhatsApp and optional verified-mailbox login               | `browser-login`, `email-authentication`; `/auth/pair`                                                                               | Existing pairing and authentication boundaries pass; provider contact email grants no mailbox login                        |
| Backup recovery and rotation                                        | `fidy support-recovery` → Cloudflare Access → `/internal/support-recovery` → Recovery/Browser Login; `/recovery/backup-code/rotate` | Real Production Access/CLI recovery, browser completion and reload pass; stale-session rotation error remains              |
| Session persistence, logout, expiry and Consent withdrawal          | Browser Login/WebSession and browser authentication registry                                                                        | Production reload and logout pass; local expiry and withdrawal checks pass; deployed deadline observation pending          |
| Denial, cancellation, blocked popup, replay and uncertain responses | Provider Authentication plus mounted browser controller                                                                             | Worker refusals and browser failure journeys pass; no blind retry or recovery redisclosure                                 |

## Evidence — 2026-10-08

Initial Production checks: `4e5c304a4d3e533b038b922f37cef713dd1647ee`.
Latest deployed revision (2026-10-09): `2801102cbf5e77eae6804d4fd4d98d7602716c9a`.
Re-runnable checks from the repository root, using its pinned Bun runtime:

```sh
bun run --cwd apps/server test:cloudflare provider-authentication onboarding/browser-authentication.test.ts browser-login/operations.test.ts recovery/support-recovery.test.ts
bun run --cwd apps/server test:cloudflare web-authentication/session-clock.test.ts
bun run --cwd apps/web test:browser 00-google-authentication.spec.ts microsoft-authentication.spec.ts browser-pairing.spec.ts
bun run --cwd apps/cli test -- src/support-recovery
bun run --cwd apps/web test -- src/features/browser-login src/features/provider-authentication src/features/recovery src/features/email-replacement
bun run --cwd infra/cloudflare test worker-observability.test.ts production-release.test.ts
```

Re-run on the revision above: 83 Worker/D1 tests, 20 browser journeys and six session-clock tests.
The Google and Microsoft signup journeys also pass the added back-navigation/reload checks:
no recovery redisclosure, Consent remains available and the authenticated session still works.
Previously passed: 14 CLI tests and 13 web tests.
The release-controller, routing and native command checks also pass (46 tests), including
secret-safe native refusal diagnostics after uncertain-write reconciliation.
Browser journeys use built static assets and real local public/Core/D1; external provider and
operator/WhatsApp delivery edges are substituted. They are reusable regression checks, not live
Google, Microsoft, Kapso or Cloudflare Access evidence.

Before the recovery upload attempts below, Production web metadata and API health matched that revision
and contract digest.
The [release](https://github.com/B4rz99/fidy-ai/actions/runs/37868801744) passed promotion and
normal-traffic gates. Public disclosure returns 200 with no-store. The previous deleted-Queue
and isolated-routing failures no longer block the signup page.

Real Google signup now succeeds after fixing `redirect: "error"`, which workerd rejected before
network I/O. Both providers and Access signing-key lookup use `manual`; workerd transport tests
cover ordinary responses and redirects. The signed-in app survives reload (`/user` and Transactions
return 200). Recovery settings show only the option to create a new code, including after reload.
Logout returns 204; subsequently opening protected Transactions receives 401 and shows session
expiry. Both provider callbacks reject synthetic invalid proofs with no-store/no-referrer 303 to
parameter-free first-party return pages. Unauthenticated support recovery returns 401.
Returning Google login also reaches Transactions, survives reload and shows no recovery code.
The live session response sets an HttpOnly, Secure, SameSite=Lax, host-only cookie with root path
and 2,592,000-second Max-Age. No cookie value was copied into evidence.
Production Core has its every-minute Maintenance schedule configured; actual expired-record
removal has not yet been observed in Production.

The User reported a Consent-loading error after navigating backwards. The session remained usable;
a fresh signup load retrieved disclosure successfully. Both automated history journeys pass, so
the reported intermittent failure remains unresolved rather than being marked fixed. A subsequent
Production back/reload/forward check loads Consent, shows no recovery code and preserves the
authenticated app; it did not reproduce the earlier failure.

Production Core and Ingress disable invocation logs, traces, Logpush and tail consumers.
A saved diagnostic previously exposed protocol query fields in Cloudflare request metadata.
[PR #1114](https://github.com/B4rz99/fidy-ai/pull/1114) enables explicit query redaction;
its [Production release](https://github.com/B4rz99/fidy-ai/actions/runs/37873062603) passed every gate.
Both Workers now report `redact_query_string: true`. Fresh, narrowly filtered Google and Microsoft
diagnostics retain request metadata without OAuth query values. No protocol values were copied
into evidence. The retained SDK upload regression and release transport checks verify serialization,
script-level application and readback; release staging refuses an unpersisted setting.
Microsoft's invalid-code diagnostic remains the generic `verification_failed`; that synthetic
refusal alone did not prove successful Microsoft token exchange.
Subsequent real Microsoft personal-account signup reaches the one-time recovery screen and,
after the User's acknowledgement, Transactions. The session survives reload; recovery settings
offer rotation without showing the original code, including after reload. Logout blocks protected
Transactions. Returning Microsoft login restores access without recovery redisclosure and survives
reload. Back/reload/forward loads Consent, shows no recovery code and preserves authenticated access.
No recovery value was inspected or copied. These tabs share browser cookies; the active session
switches on login, so separate tabs do not establish isolated Google and Microsoft sessions.

Recovery deployment and real journey (2026-10-09): PRs #1115/#1116 added the dedicated
Access resources and closed upload diagnostics. Initial resource upload failed with
`Forbidden`/`Unauthorized`; after correcting deployment-token permissions, the
[release](https://github.com/B4rz99/fidy-ai/actions/runs/37878216469) succeeded for
`2801102cbf5e77eae6804d4fd4d98d7602716c9a`, including promotion, smoke, topology,
normal-traffic and drift gates. Live readback confirmed one restricted recovery application,
15-minute policy, sole approved operator group and email-PIN provider. Unauthenticated requests
redirect to Access; the release gate verifies actual issuer/audience agreement with Core.
The User completed email-PIN operator login and the real cloudflared/CLI flow. CLI approval
completed the original browser pairing into Transactions; protected data loaded after reload.
No claimant code, operator token or cookie value was copied into evidence. Production
consumed-code replay refusal and subsequent rotation remain unverified.

Recovery rotation has a confirmed active-session error: after the ten-minute freshness window,
the API returns `unauthenticated` and the browser displays session expiry although Transactions
still works. Fresh provider sign-in followed by rotation succeeded for the User. [PR #1117](https://github.com/B4rz99/fidy-ai/pull/1117) now returns 403 `user_action_required` for a live session past the freshness window.
Both Google and Microsoft built-browser journeys now verify the sign-in link and continued Transactions
access; the Worker/D1 regression verifies refusal without changing the recovery proof. Thirty recovery,
authentication and session-clock tests, three recovery UI tests and type checking pass. Its
[Production release](https://github.com/B4rz99/fidy-ai/actions/runs/37913919939) succeeded for
`ddb1bde82e33e01cb5e066746b1c166e8d0935a4`; recovered browser access survives the deployment.
The User verified the deployed rotation refusal: it requests fresh sign-in and explains that the
current session remains active. Transactions then loaded in that same recovered browser session.
Direct Production cleanup observation remains unavailable: the existing CLI database read was refused.

Recovery controls (2026-10-09): further Worker/D1 testing reproduced a new-sign-in failure when an
approved recovery pairing expired without redemption. The follow-up preserves case-referenced pairings,
adds scheduled 24-calendar-month terminal evidence retention, and enforces the documented operator
5/minute and 20/hour and global 20/minute and 100/hour rolling admission limits. Thirty-nine focused
tests pass, including concurrent requests, exact rolling boundaries, leap-day retention, and atomic
cleanup rollback without restoring consumed proof. Deployment remains pending. Open-case retry
tracking and verified Titular deletion are not implemented; they are not verified capabilities.

On the latest revision, both providers refuse missing/wrong proof cookies, duplicate state and
cross-provider callbacks while preserving the legitimate pending attempt. Synthetic provider denial
and replay reject completion and return to clean first-party URLs. Signup without Consent returns
400, anonymous current-User access returns 401 and an untrusted browser origin returns 403.
An unapproved Production pairing on `3a0bb529fe2676def32b756aaebaacc6cd6d99cd` refused redemption
with a no-store 400 after 606 seconds.
These synthetic checks create no User or session. Their reusable local counterparts are in the
provider journey and Browser Login integration suites above; actual provider denial UI remains pending.
The real Google-authenticated app also survives reload after the latest deployment without recovery
code redisclosure.

Remaining live checks: Google and Microsoft personal denial UI;
Microsoft work/school signup/returning login/denial (unavailable: the User has no work/school account);
real WhatsApp association and forwarded/expired handoff
refusal; consumed recovery-code replay and post-recovery rotation; deployed server-side session deadlines and retention.
Local fixture passes do not establish these Production results. The User approved
personal Google, Microsoft and WhatsApp accounts and handles sign-in and confirmation.

[Provider configuration and live checks](../../../../../docs/operations/authentication-feature-map.md)
and [recovery procedure](../../../../../docs/operations/support-recovery.md) contain operator details.

Recovery decision timing: held-body Worker/D1 regressions previously approved after operator assertion
or pairing expiry. The follow-up rechecks verified assertion time and uses the post-read decision
instant for pairing/proof guards. Both exact-expiry regressions pass; Production deployment is pending.
