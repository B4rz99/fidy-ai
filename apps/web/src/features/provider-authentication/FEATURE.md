# Signup and browser login

Google and Microsoft authenticate a ProviderCredential by issuer/subject. Contact email never
merges Users or establishes mailbox authority. Onboarding atomically creates the User, Consent,
168-hour TrialPeriod and digest-only BackupRecoveryCode. Browser Login alone issues WebSession
after approval and proof of the initiating browser's private verifier.

| Action                                                              | Code and runtime                                                                                                                    | Verification                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Public signup and returning login                                   | This feature, `/auth/google`, `/auth/microsoft` → public Ingress → private Core Provider Authentication → D1                        | Real Google signup and returning login reach the app without recovery redisclosure; Microsoft live checks pending          |
| Consent and one-time recovery acknowledgement                       | `/web/providers/disclosure`, provider start/completion; Onboarding                                                                  | Atomic creation/rollback, concurrent completion, same-contact isolation and lost-response non-redisclosure covered locally |
| WhatsApp-led signup and initial linking                             | Kapso authenticated Portfolio/BSUID → Consent handoff → provider browser → exact originating-message association approval           | New and existing User journeys pass for both providers; real Kapso delivery/reply pending                                  |
| Existing WhatsApp and optional verified-mailbox login               | `browser-login`, `email-authentication`; `/auth/pair`                                                                               | Existing pairing and authentication boundaries pass; provider contact email grants no mailbox login                        |
| Backup recovery and rotation                                        | `fidy support-recovery` → Cloudflare Access → `/internal/support-recovery` → Recovery/Browser Login; `/recovery/backup-code/rotate` | Both provider browser journeys recover the same User and rotate; native command tests pass; real Access recovery pending   |
| Session persistence, logout, expiry and Consent withdrawal          | Browser Login/WebSession and browser authentication registry                                                                        | Production reload and logout pass; local expiry and withdrawal checks pass; deployed deadline observation pending          |
| Denial, cancellation, blocked popup, replay and uncertain responses | Provider Authentication plus mounted browser controller                                                                             | Worker refusals and browser failure journeys pass; no blind retry or recovery redisclosure                                 |

## Evidence — 2026-10-08

Production checked: `4e5c304a4d3e533b038b922f37cef713dd1647ee`.
Re-runnable checks from the repository root, using its pinned Bun runtime:

```sh
bun run --cwd apps/server test:cloudflare provider-authentication onboarding/browser-authentication.test.ts browser-login/operations.test.ts recovery/support-recovery.test.ts
bun run --cwd apps/server test:cloudflare web-authentication/session-clock.test.ts
bun run --cwd apps/web test:browser 00-google-authentication.spec.ts microsoft-authentication.spec.ts browser-pairing.spec.ts
bun run --cwd apps/cli test -- src/support-recovery
bun run --cwd apps/web test -- src/features/browser-login src/features/provider-authentication src/features/recovery src/features/email-replacement
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

Production web deployment metadata and API health match the revision above and contract digest.
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
However, a narrowly filtered saved authentication diagnostic still contains protocol query fields
in Cloudflare's request metadata; the application log contains only closed failure codes.
Deployed `redact_query_string` is false. Explicit platform query redaction and fresh-log verification
are required before marking callback logging safe. No protocol values were copied into evidence.
The retained SDK patch and upload transport regression send the query-redaction setting.
The release transport checks apply and read back script-level redaction before gradual staging,
refusing to proceed if the provider does not persist it. Deployment verification remains pending.

Remaining live checks: Google denial; Microsoft personal and
work/school signup/returning login/denial; real WhatsApp association and forwarded/expired handoff
refusal; Access-backed recovery; deployed server-side session deadlines, retention and callback-query
log exclusion. Local fixture passes do not establish these Production results. The User approved
personal Google, Microsoft and WhatsApp accounts and handles sign-in and confirmation.

[Provider configuration and live checks](../../../../../docs/operations/authentication-feature-map.md)
and [recovery procedure](../../../../../docs/operations/support-recovery.md) contain operator details.
