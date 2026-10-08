# Google web authentication (#1089)

Implemented: discoverable `/auth/google`, explicit current web Consent for signup, Google OIDC,
atomic User/ProviderCredential/Consent/168-hour TrialPeriod/digest-only recovery creation, and
Browser Login private-verifier redemption. Returning Google authentication preserves stable User
ownership even without an email claim. It never silently merges another issuer/subject, renews a
trial, reinstates Consent, or creates WhatsAppIdentity/VerifiedEmailCredential. The old channel/mailbox
journey remains installed. Microsoft, provider linking, and WhatsApp signup replacement are later tickets.

## Operator configuration

Create a Google OAuth client of application type **Web application**. Register exactly
`https://api.fidyapp.com/providers/google/callback` as the authorized redirect. Supply
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` through the existing Production workflow secrets;
Alchemy passes the secret as a redacted Core secret binding, never to Ingress or browser assets.
Alchemy sets `GOOGLE_REDIRECT_URI` itself; mismatching runtime callback configuration fails closed.
Use authentication scopes `openid email` only, with no Gmail or mailbox-reading scope.

Local Alchemy defaults to disabled credentials and the fixed localhost callback. Use the built HTTPS
acceptance topology for deterministic synthetic evidence. A fixture client or passing build does
not establish Google delivery, consent-screen approval, deployed callback correctness, or launch readiness.

The API cookie holds the transient PKCE verifier (HttpOnly, Secure, SameSite=Lax), while D1 retains
its digest. The browser keeps the independent pairing verifier/recovery only in mounted memory.
Callback claims are validated with bounded fixed-host Google HTTP requests and local signature
verification. The code exchange is claimed once before egress; uncertain delivery is not retried.
Status checks can repeat; completion and Browser Login redemption are sent once per attempt.

The callback issues a no-store/no-referrer 303 to `/auth/google-return` without parameters. Automatic
Worker invocation logs are disabled in the declared topology. Before real provider use, confirm
that HTTP Logpush, Log Explorer, tail consumers, error reporting and any proxy logs exclude the
callback query string. Do not collect HAR, traces, videos or screenshots containing protocol or
recovery secrets. Pairing expiry pruning cascades transient attempts/receipts; Maintenance also
prunes expired protocol state after one day. Durable credentials and Consent evidence remain.

## Evidence and remaining gates

Worker/D1 checks cover signature/claim refusals, proof/state/cookie binding, stable subject ownership,
email changes and same-email isolation, callback replay, atomic rollback, duplicate/concurrent
completion, recovery non-redisclosure and Browser Login session issuance. Built-browser checks use
real Core/D1 with only the external Google edge substituted; they cover signup, returning login,
reload/logout/expiry, denial/cancellation, lost committed response, and login after Consent withdrawal
while ordinary work remains blocked. The preserved onboarding/Browser Login checks remain required.

- [ ] Verify the actual Google application, test-user/consent-screen settings, scopes and exact callback.
- [ ] Verify the deployed Core client ID and secret binding, fixed callback, D1 migration and cron retention.
- [ ] Inspect deployed callback log exclusions and cookie behavior on the real app/API origins.
- [ ] Run real Google signup/login, returning login, denial and logout with approved test accounts.
- [ ] Confirm one-time recovery presentation and ordinary-work refusal after Consent withdrawal.

[Google OIDC protocol](https://developers.google.com/identity/openid-connect/openid-connect) and
[Cloudflare secret bindings](https://developers.cloudflare.com/workers/configuration/secrets/)
provide the external protocol/configuration references. These checks remain unchecked until actual evidence exists.
