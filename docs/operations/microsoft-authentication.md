# Microsoft web authentication (#1090)

Implemented: `/auth/microsoft` uses the shared provider UI, atomic Onboarding owners and separate
Browser Login redemption. Explicit current web Consent precedes signup; recovery is disclosed once
and acknowledged before session redemption. Returning issuer/subject authentication keeps the same
User without resetting TrialPeriod or reinstating withdrawn Consent. No WhatsAppIdentity or mailbox
code is required. Email/preferred_username are optional contact/display data, never ownership,
mailbox verification or a reason to merge Google/Microsoft Users.

## Accepted accounts and configuration

The User explicitly approved **personal and work/school accounts from all Microsoft Entra tenants**
on 2026-10-07. Register an application with `AzureADandPersonalMicrosoftAccount` supported account
types (any organizational directory and personal Microsoft accounts). Use the Web platform with
exact redirect `https://api.fidyapp.com/providers/microsoft/callback`. This is a confidential server
code flow with S256 PKCE; no SPA secret, implicit flow, Graph/mailbox permission or offline access.
Request only `openid email`; absent email/preferred_username does not prevent login.

Production workflow secrets `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` feed private Core
bindings through Alchemy; the secret stays redacted. Alchemy fixes `MICROSOFT_REDIRECT_URI` to the
exact API callback. Missing credentials or mismatched callback configuration fails closed. Local
Alchemy defaults to disabled credentials with `http://localhost:8787/providers/microsoft/callback`.
The deterministic HTTPS acceptance topology uses synthetic credentials, not a real registration.

Authorize/token/JWKS destinations are fixed public-cloud `login.microsoftonline.com/common` v2
endpoints. Token validation requires RS256 signature, GUID tid, exact tenant-qualified issuer,
v2 version, intended single audience, expiry, issued-at and nonce. Every selected signing key must
match the token issuer directly or through Microsoft's tenant template. No token-selected URL is
fetched. Sovereign-cloud/B2C issuers and custom application signing-key metadata are unsupported.

The API PKCE cookie is HttpOnly/Secure/SameSite=Lax; D1 stores only its digest. The independent
Browser Login proof and recovery remain in mounted browser memory. Each attempt is bound to its
selected provider. Callback exchange and completion are single-use with no blind retry. Every
callback outcome redirects 303 with no-store/no-referrer to parameter-free `/auth/microsoft-return`.
Expiry pruning/retention removes transient state while preserving durable credentials and Consent.

## Evidence and remaining checks

Worker/D1 checks cover personal/organizational signup, stable returning ownership, changed/missing
contact claims, same-contact Google separation, issuer/tenant/key-scope/signature/audience/version/
nonce/expiry refusals, provider substitution, replay, atomic rollback/concurrent completion,
one-time recovery, secret-free diagnostics and cancellation of stalled signing-key retrieval.
Hostile/absent Origin refuses all three Microsoft mutations before authority or effects.
The provider-neutral `web-provider-2026-10-07` disclosure is displayed and recorded with its exact
text/hash; the prior Google-only revision is refused for new signup. Recorded Consent snapshots
are never rewritten.
Built-browser journeys exercise real Core/D1 signup, acknowledgment, returning login, reload/logout,
session expiry and withdrawn Consent, plus denial/cancellation, lost completion, pending redemption and blocked-popup refusal/restart.
The WhatsApp provider handoff has not landed; its combined matrix remains a later ticket.

Fixture evidence does not establish Microsoft or Production readiness. These gates remain pending:

- [ ] Verify actual app registration/account types, exact redirect, permissions and current secret.
- [ ] Verify deployed Core bindings, migration 0064 and retention.
- [ ] Verify callback query exclusion in edge/proxy logs, tail consumers and error reporting; never capture HAR, traces, video or screenshots containing protocol/recovery secrets.
- [ ] Verify secure cookie behavior on the real app/API origins and applicable browser policies.
- [ ] Exercise real personal and work/school signup/login, denial/logout and one-time recovery.
- [ ] Verify missing/changed contact claims and ordinary-work refusal after Consent withdrawal.

Protocol references: [Microsoft OIDC](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc),
[tenant/key issuer validation](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens),
[ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference),
[Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
