# Fidy product identity and public namespace

- **Status:** Accepted
- **Date:** 2026-07-28
- **Active specification:** [Product name, domain & external endpoints](https://github.com/B4rz99/fidy-ai/issues/9)

## Context

The product name and externally visible addresses were deliberately deferred while the MVP was
specified. Leaving them unresolved now would make the web login, policy, inbound email, WhatsApp,
and billing integrations invent addresses independently, and changing those addresses after
provider onboarding would require coordinated external reconfiguration.

The root domain already receives Google Workspace mail. Pointing Resend receiving at that same root
would conflict with its MX record and risk ordinary Fidy email.

## Decision

The product is named **Fidy**, and its canonical public domain is **`fidyapp.com`**.

The public namespace is fixed as follows:

- web origin: `https://fidyapp.com`
- política de tratamiento: `https://fidyapp.com/politica`
- magic-link entry: `https://fidyapp.com/auth/magic`
- API origin: `https://api.fidyapp.com`
- Kapso webhook: `https://api.fidyapp.com/webhooks/kapso`
- Wompi callback: `https://api.fidyapp.com/webhooks/wompi`
- personal ingestion addresses: `@ingest.fidyapp.com`

Google Workspace keeps the root MX record. Resend receives only on the `ingest.fidyapp.com`
subdomain, so ingestion can change without disturbing ordinary mail. DNS owns the stable names;
the deployment behind each name may change without changing provider callbacks or user-facing
addresses.

## Consequences

Dependent tickets consume the public namespace through the shared Effect configuration rather than
restating URLs. The policy and magic-link routes belong to the web origin; provider callbacks
belong to the API origin. A future host migration updates DNS, not the external contracts.
