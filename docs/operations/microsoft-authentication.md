# Configure Microsoft authentication

For personal and work/school accounts from all Microsoft Entra tenants, register an application with `AzureADandPersonalMicrosoftAccount` supported account
types (any organizational directory and personal Microsoft accounts). Use the Web platform with
exact redirect `https://api.fidyapp.com/providers/microsoft/callback`. This is a confidential server
code flow with S256 PKCE; no SPA secret, implicit flow, Graph/mailbox permission or offline access.
Request only `openid email`; absent email/preferred_username does not prevent login.

Production workflow secrets `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` feed private Core
bindings through Alchemy; the secret stays redacted. Alchemy fixes `MICROSOFT_REDIRECT_URI` to the
exact API callback. Missing credentials or mismatched callback configuration fails closed. Local
Alchemy defaults to disabled credentials with `http://localhost:8787/providers/microsoft/callback`.
The deterministic HTTPS acceptance topology uses synthetic credentials, not a real registration.

## Verify configuration

- [ ] Verify actual app registration/account types, exact redirect, permissions and current secret.
- [ ] Verify deployed Core bindings, current D1 schema and retention.
- [ ] Verify callback query exclusion in edge/proxy logs, tail consumers and error reporting; never capture HAR, traces, video or screenshots containing protocol/recovery secrets.
- [ ] Verify secure cookie behavior on the real app/API origins and applicable browser policies.
- [ ] Exercise real personal and work/school signup/login, denial/logout and one-time recovery.
- [ ] Verify missing/changed contact claims and ordinary-work refusal after Consent withdrawal.

Protocol references: [Microsoft OIDC](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc),
[tenant/key issuer validation](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens),
[ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference),
[Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
