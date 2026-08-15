# External endpoints

Fidy's stable public namespace is decided in
[ADR-0002](../adr/0002-fidy-product-identity-and-public-namespace.md). This runbook records the
operational state expected by dependent deployments.

## Ownership and routing

- `fidyapp.com` is registered in the operator's Spaceship account.
- `apps/web` owns the portable static web artifact. Cloudflare hosts Production at `fidyapp.com`;
  Railway hosts the independently deployed API at `api.fidyapp.com`.
- Google Workspace handles mail for `@fidyapp.com`.
- Resend is configured to send and receive for `ingest.fidyapp.com`; the domain uses the São Paulo
  sending region and enforced TLS.

The root and ingestion domains deliberately have separate MX records. Never replace the root Google
Workspace MX record with Resend's inbound record.

## Runtime configuration

The shared `externalEndpoints` configuration in
[`apps/server/src/shell/_shared/external-endpoints.ts`](../../apps/server/src/shell/_shared/external-endpoints.ts)
derives all stable paths from these variables. The web build validates `VITE_API_ORIGIN` separately. Browser login uses `/auth/pair`; PAT management uses
`/settings/pats`. The former `/auth/magic` entry is retired by ADR 0015:

| Variable              | Production value          |
| --------------------- | ------------------------- |
| `PUBLIC_WEB_ORIGIN`   | `https://fidyapp.com`     |
| `PUBLIC_API_ORIGIN`   | `https://api.fidyapp.com` |
| `VITE_API_ORIGIN`     | `https://api.fidyapp.com` |
| `INGEST_EMAIL_DOMAIN` | `ingest.fidyapp.com`      |

Every deployment must set the variables applicable to its process or build. Production uses the
values above; local and preview deployments use their own origins and ingestion domain so they cannot
silently call production addresses. See the [Production release runbook](production-releases.md) for
the provider and GitHub environment configuration.

## Verification

Check the authoritative nameservers and mail routing:

```sh
dig +short NS fidyapp.com
dig +short MX fidyapp.com
dig +short MX ingest.fidyapp.com
```

The expected nameservers are the two assigned by the active Cloudflare zone. The root MX must remain
Google Workspace, while the ingestion MX must resolve to Resend's inbound SMTP target. Follow the
[DNS and registrar migration runbook](dns-and-registrar-migration.md) when moving authority or
registration.

Check Resend after DNS propagation:

```sh
resend domains list
resend domains get <domain-id>
```

The `ingest.fidyapp.com` Receiving record must report `verified` before ingestion starts. Its DKIM
and SPF records must also report `verified` before a dependent ticket sends outbound mail. Provider
webhook handlers and the policy, browser-pairing, and recovery pages are delivered by their
dependent tickets; this ticket reserves their DNS names and route contracts rather than implementing
those capabilities.
