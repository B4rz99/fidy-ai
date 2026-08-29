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
Workspace MX record with Resend's inbound record. The production DNS reconciler writes only the exact
`ingest.fidyapp.com`, `send.ingest.fidyapp.com`, and Resend-provided DKIM names; its negative test
proves it never queries or mutates a root MX record.

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

The `ingest.fidyapp.com` Receiving record must report `verified` before ingestion starts. Copy the
exact Receiving MX, sending MX, SPF, and DKIM values returned by Resend into the
`RESEND_INGEST_*` production variables, run `bun scripts/production/cloudflare-dns.ts`, and then
request Resend verification. Provision the callback with
`resend webhooks create --endpoint https://api.fidyapp.com/webhooks/resend --events email.received`
and immediately store its one-time `signing_secret` as Railway's `RESEND_WEBHOOK_SECRET`; never
print or commit it. Its Receiving, DKIM, and SPF records must all report `verified`, and
`resend webhooks list` must show that enabled endpoint, before ingestion or outbound mail starts.
