# Fidy product identity and public namespace

- **Status:** Accepted
- **Date:** 2026-07-28
- **Active specification:** [Product name, domain & external endpoints](https://github.com/B4rz99/fidy-ai/issues/9)
- **Current addresses:** [External endpoints](../operations/external-endpoints.md)

## Context

The product name and externally visible addresses were deliberately deferred while the MVP was
specified. Leaving them unresolved now would make the web login, policy, inbound email, WhatsApp,
and billing integrations invent addresses independently, and changing those addresses after
provider onboarding would require coordinated external reconfiguration.

The root domain already receives Google Workspace mail. Routing inbound ingestion at that same root
would conflict with its MX record and risk ordinary Fidy email.

## Decision

The product is named **Fidy**, and its canonical public domain is **`fidyapp.com`**.

Keep the root mail exchange with Google Workspace and route forwarded ingestion through its own
subdomain. Fidy can change the implementation behind its stable names without disturbing ordinary
mail or reconfiguring every caller. Share canonical addresses through owned configuration.
The endpoint inventory owns active hosts and routes. [ADR 0015](0015-browser-paired-web-authentication.md)
owns the browser pairing contract.
