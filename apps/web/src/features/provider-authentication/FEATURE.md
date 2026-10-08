# Signup and browser login

Google and Microsoft authenticate a ProviderCredential by issuer/subject. Contact email never
merges Users or establishes mailbox authority. Onboarding atomically creates the User, Consent,
168-hour TrialPeriod and digest-only BackupRecoveryCode. Browser Login alone issues WebSession
after approval and proof of the initiating browser's private verifier.

| Action                                                              | Code and runtime                                                                                                                    | Verification                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Public signup and returning login                                   | This feature, `/auth/google`, `/auth/microsoft` → public Ingress → private Core Provider Authentication → D1                        | Both providers pass Worker/D1 and built-browser journeys; real provider authentication pending                              |
| Consent and one-time recovery acknowledgement                       | `/web/providers/disclosure`, provider start/completion; Onboarding                                                                  | Atomic creation/rollback, concurrent completion, same-contact isolation and lost-response non-redisclosure covered locally  |
| WhatsApp-led signup and initial linking                             | Kapso authenticated Portfolio/BSUID → Consent handoff → provider browser → exact originating-message association approval           | New and existing User journeys pass for both providers; real Kapso delivery/reply pending                                   |
| Existing WhatsApp and optional verified-mailbox login               | `browser-login`, `email-authentication`; `/auth/pair`                                                                               | Existing pairing and authentication boundaries pass; provider contact email grants no mailbox login                         |
| Backup recovery and rotation                                        | `fidy support-recovery` → Cloudflare Access → `/internal/support-recovery` → Recovery/Browser Login; `/recovery/backup-code/rotate` | Both provider browser journeys recover the same User and rotate; native command tests pass; real Access recovery pending    |
| Session persistence, logout, expiry and Consent withdrawal          | Browser Login/WebSession and browser authentication registry                                                                        | Browser reload/logout, simulated expiry and blocked ordinary work after withdrawal pass locally; deployed deadlines pending |
| Denial, cancellation, blocked popup, replay and uncertain responses | Provider Authentication plus mounted browser controller                                                                             | Worker refusals and browser failure journeys pass; no blind retry or recovery redisclosure                                  |

## Evidence — 2026-10-08

Checked source: `acddc7bafe675a3aaffc8653acf13aa09c80e815`.
Re-runnable checks from the repository root, using its pinned Bun runtime:

```sh
bun run --cwd apps/server test:cloudflare provider-authentication onboarding/browser-authentication.test.ts browser-login/operations.test.ts recovery/support-recovery.test.ts
bun run --cwd apps/web test:browser google-authentication.spec.ts microsoft-authentication.spec.ts browser-pairing.spec.ts
bun run --cwd apps/cli test -- src/support-recovery
bun run --cwd apps/web test -- src/features/browser-login src/features/provider-authentication src/features/recovery src/features/email-replacement
```

Passed: 80 Worker/D1 tests, 20 browser journeys, 14 CLI tests and 13 web tests.
The release-controller, routing and native command checks also pass (46 tests), including
secret-safe native refusal diagnostics after uncertain-write reconciliation.
Browser journeys use built static assets and real local public/Core/D1; external provider and
operator/WhatsApp delivery edges are substituted. They are reusable regression checks, not live
Google, Microsoft, Kapso or Cloudflare Access evidence.

Manual Production check: the public signup link opens `/auth/google`, but its Consent loading
fails. `GET https://api.fidyapp.com/web/providers/disclosure` returns 404. API `/health` reports
`449b2a47726c6b88133d84488b90c65e0a6c6beb`, before provider signup was implemented.
The [diagnostic deployment](https://github.com/B4rz99/fidy-ai/actions/runs/37854432026) failed during
zero-traffic routing with Cloudflare API code 10210 and `resource=queue`; guarded cleanup succeeded.
Signup is **blocked in Production**, not verified.

Read-only [traffic inspection](https://github.com/B4rz99/fidy-ai/actions/runs/37848592357)
confirmed stable public/Core traffic and no topology drift. The uploaded candidate exists. Both
stable and candidate Core versions are listed as deployable, but the stable Core's referenced
onboarding Workflow returns 404 and its onboarding Queue binding reports `queue_deleted: true`.
All other stable Queue and Workflow references resolve. The native refusal now confirms the Queue
category, consistent with the deleted onboarding Queue. Do not force promotion.

The incident recovery uses isolated Ingress/Core admission, checks private Core reachability,
and requires normal-routing synthetic proof before the ordinary release gates. Regression checks
cover denial even with a valid smoke proof, proof-before-Core ordering, failed proof and a superseded
revision. The [recovery procedure](../../../../../docs/operations/production-recovery.md) preserves
existing User records; it remains pending in Production.

Live Ingress/Core settings disable invocation logs, traces, Worker Logpush and tail consumers.
Authenticated dashboard inspection shows Logpush subscription prompts at account and domain level,
and no OpenTelemetry export destinations. Callback invocation records are disabled; actual live
provider callbacks remain untested.

Remaining: restore a matching deployed web/API release; verify real Google and Microsoft personal
and work/school signup/returning login/denial with test identities; real WhatsApp association and
forwarded/expired handoff refusal; Access-backed recovery; deployed session/cookie deadlines,
retention and callback-query log exclusion. Keep protocol and recovery secrets out of evidence.
The User approved personal Google, Microsoft and WhatsApp accounts and will handle sign-in;
interactive verification remains pending.

[Provider configuration and live checks](../../../../../docs/operations/authentication-feature-map.md)
and [recovery procedure](../../../../../docs/operations/support-recovery.md) contain operator details.
