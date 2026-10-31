# Configure Google authentication

Create a Google OAuth client of application type **Web application**. Register exactly
`https://api.fidyapp.com/providers/google/callback` as the authorized redirect. Supply
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` through the existing Production workflow secrets;
Alchemy passes the secret as a redacted Core secret binding, never to Ingress or browser assets.
Alchemy sets `GOOGLE_REDIRECT_URI` itself; mismatching runtime callback configuration fails closed.
Use authentication scopes `openid email` only, with no Gmail or mailbox-reading scope.

Local Alchemy defaults to disabled credentials and the fixed localhost callback. Use the built HTTPS
acceptance topology for deterministic synthetic evidence. A fixture client or passing build does
not establish Google delivery, consent-screen approval, deployed callback correctness, or launch readiness.

## Verify configuration

- [ ] Verify the actual Google application, test-user/consent-screen settings, scopes and exact callback.
- [ ] Verify the deployed Core client ID and secret binding, fixed callback, D1 migration and cron retention.
- [ ] Inspect deployed callback log exclusions and cookie behavior on the real app/API origins.
- [ ] Run real Google signup/login, returning login, denial and logout with approved test accounts.
- [ ] Confirm one-time recovery presentation and ordinary-work refusal after Consent withdrawal.

[Google OIDC protocol](https://developers.google.com/identity/openid-connect/openid-connect) and
[Cloudflare secret bindings](https://developers.cloudflare.com/workers/configuration/secrets/)
provide the external protocol/configuration references. These checks remain unchecked until actual evidence exists.
