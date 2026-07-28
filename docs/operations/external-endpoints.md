# External endpoints

Fidy's stable public namespace is decided in
[ADR-0002](../adr/0002-fidy-product-identity-and-public-namespace.md). This runbook records the
operational state expected by dependent deployments.

## Ownership and routing

- `fidyapp.com` is registered in the operator's Spaceship account.
- Vercel hosts the public web origin and manages the authoritative DNS zone.
- Google Workspace handles mail for `@fidyapp.com`.
- Resend is configured to send and receive for `ingest.fidyapp.com`; the domain uses the São Paulo
  sending region and enforced TLS.

The root and ingestion domains deliberately have separate MX records. Never replace the root Google
Workspace MX record with Resend's inbound record.

## Runtime configuration

The shared `externalEndpoints` configuration in
[`src/shell/_shared/external-endpoints.ts`](../../src/shell/_shared/external-endpoints.ts) derives all
stable paths from these variables:

| Variable              | Production value          |
| --------------------- | ------------------------- |
| `PUBLIC_WEB_ORIGIN`   | `https://fidyapp.com`     |
| `PUBLIC_API_ORIGIN`   | `https://api.fidyapp.com` |
| `INGEST_EMAIL_DOMAIN` | `ingest.fidyapp.com`      |

Every deployment must set all three variables. Production uses the values above; local and preview
deployments use their own origins and ingestion domain so they cannot silently call production
addresses.

## Verification

Check the authoritative nameservers and mail routing:

```sh
dig +short NS fidyapp.com
dig +short MX fidyapp.com
dig +short MX ingest.fidyapp.com
```

The expected nameservers are `ns1.vercel-dns.com` and `ns2.vercel-dns.com`. The root MX must remain
Google Workspace, while the ingestion MX must resolve to Resend's inbound SMTP target.

Check Resend after DNS propagation:

```sh
resend domains list
resend domains get <domain-id>
```

The `ingest.fidyapp.com` Receiving record must report `verified` before ingestion starts. Its DKIM
and SPF records must also report `verified` before a dependent ticket sends outbound mail. Provider
webhook handlers and the policy and magic-link pages are delivered by their dependent tickets; this
ticket reserves their DNS names and route contracts rather than implementing those capabilities.
