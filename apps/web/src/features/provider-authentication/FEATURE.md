# Signup and browser login

Google and Microsoft authenticate a ProviderCredential by issuer/subject. Contact email never
merges Users or establishes mailbox authority. Onboarding atomically creates the User, Consent,
168-hour TrialPeriod and digest-only BackupRecoveryCode. Browser Login alone issues WebSession
after approval and proof of the initiating browser's private verifier.

| Action                                                              | Code and runtime                                                                                                                    | Verification                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Public signup and returning login                                   | This feature, `/auth/google`, `/auth/microsoft` → public Ingress → private Core Provider Authentication → D1                        | Local journeys pass; real Google callback rejected twice; Microsoft live checks pending                                     |
| Consent and one-time recovery acknowledgement                       | `/web/providers/disclosure`, provider start/completion; Onboarding                                                                  | Atomic creation/rollback, concurrent completion, same-contact isolation and lost-response non-redisclosure covered locally  |
| WhatsApp-led signup and initial linking                             | Kapso authenticated Portfolio/BSUID → Consent handoff → provider browser → exact originating-message association approval           | New and existing User journeys pass for both providers; real Kapso delivery/reply pending                                   |
| Existing WhatsApp and optional verified-mailbox login               | `browser-login`, `email-authentication`; `/auth/pair`                                                                               | Existing pairing and authentication boundaries pass; provider contact email grants no mailbox login                         |
| Backup recovery and rotation                                        | `fidy support-recovery` → Cloudflare Access → `/internal/support-recovery` → Recovery/Browser Login; `/recovery/backup-code/rotate` | Both provider browser journeys recover the same User and rotate; native command tests pass; real Access recovery pending    |
| Session persistence, logout, expiry and Consent withdrawal          | Browser Login/WebSession and browser authentication registry                                                                        | Browser reload/logout, simulated expiry and blocked ordinary work after withdrawal pass locally; deployed deadlines pending |
| Denial, cancellation, blocked popup, replay and uncertain responses | Provider Authentication plus mounted browser controller                                                                             | Worker refusals and browser failure journeys pass; no blind retry or recovery redisclosure                                  |

## Evidence — 2026-10-08

Production checked: `2becd7945141224e2df7002d94a705854fe23f87`; local checks include the pending Workers redirect fix.
Re-runnable checks from the repository root, using its pinned Bun runtime:

```sh
bun run --cwd apps/server test:cloudflare provider-authentication onboarding/browser-authentication.test.ts browser-login/operations.test.ts recovery/support-recovery.test.ts
bun run --cwd apps/web test:browser google-authentication.spec.ts microsoft-authentication.spec.ts browser-pairing.spec.ts
bun run --cwd apps/cli test -- src/support-recovery
bun run --cwd apps/web test -- src/features/browser-login src/features/provider-authentication src/features/recovery src/features/email-replacement
```

Passed: 81 Worker/D1 tests, 20 browser journeys, 14 CLI tests and 13 web tests.
The release-controller, routing and native command checks also pass (46 tests), including
secret-safe native refusal diagnostics after uncertain-write reconciliation.
Browser journeys use built static assets and real local public/Core/D1; external provider and
operator/WhatsApp delivery edges are substituted. They are reusable regression checks, not live
Google, Microsoft, Kapso or Cloudflare Access evidence.

Production web deployment metadata and API health match the revision above and contract digest.
The [release](https://github.com/B4rz99/fidy-ai/actions/runs/37859954800) restored disclosure
availability: its public GET returns 200 with no-store and no-referrer. The previous deleted-Queue
and isolated-routing failures no longer block the signup page.

Real Google signup failed again after the User completed provider sign-in. Provider start returns
200; proof-bearing status ends in `rejected`; the browser sends no completion or session-redemption
request. Production's structured callback diagnostic reports `token_transport_failed`. A real
workerd probe reproduces the cause: OIDC selected `redirect: "error"`, which Workers rejects before
network I/O. Access recovery signing-key retrieval had the same defect. The transport regressions
validate both providers and Access signing-key fetch options with workerd and
requires ordinary responses and redirects to remain observable without following them. The pending
fix uses `manual`; successful real sign-in remains unverified. Callback diagnostics use closed codes;
no protocol values, provider body, identity, or recovery material may enter the evidence.
The fix passes 42 Google/Microsoft journey and workerd transport checks plus 21 outbound-policy tests.
A local workerd probe with synthetic invalid values reaches Google's token endpoint (401) under
`manual`; the same probe throws before network I/O under `error`.

Remaining live checks: successful Google signup/returning login/denial; Microsoft personal and
work/school signup/returning login/denial; real WhatsApp association and forwarded/expired handoff
refusal; Access-backed recovery; deployed session/cookie deadlines, retention and callback-query
log exclusion. Local fixture passes do not establish these Production results. The User approved
personal Google, Microsoft and WhatsApp accounts and handles sign-in and confirmation.

[Provider configuration and live checks](../../../../../docs/operations/authentication-feature-map.md)
and [recovery procedure](../../../../../docs/operations/support-recovery.md) contain operator details.
