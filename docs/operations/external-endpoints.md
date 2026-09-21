# External endpoints

Fidy's stable public namespace is decided in
[ADR-0002](../adr/0002-fidy-product-identity-and-public-namespace.md). This runbook records the
Cloudflare-owned endpoint boundary.

## Ownership and routing

- `fidyapp.com` is the Cloudflare custom domain for the static web Worker.
- The future API Worker uses the configured API origin only after its Cloudflare adapter and smoke
  checks are present. The current static Worker does not impersonate an API.
- Google Workspace remains authoritative for mail at `@fidyapp.com`.
- Email Workers own inbound email admission and handoff. Resend is outbound-only and is never an
  inbound webhook authority.
- Kapso/Meta and Wompi remain specialist callback and egress boundaries. Their credentials and
  verification live in the Cloudflare adapter configuration, not in browser assets.

Do not add a process server, a local database, or a provider-owned source deployment to repair an
unavailable endpoint. Add the corresponding Worker binding and typed adapter instead.

## Runtime configuration

The public HTTP contract derives stable web and API origins from these variables. The web build
validates `VITE_API_ORIGIN` separately. Browser login uses `/auth/pair`; PAT management uses
`/settings/pats`. The retired `/auth/magic` path is not an endpoint.

| Variable            | Local example           | Production value          |
| ------------------- | ----------------------- | ------------------------- |
| `PUBLIC_WEB_ORIGIN` | `http://localhost:5173` | `https://fidyapp.com`     |
| `PUBLIC_API_ORIGIN` | `http://localhost:3000` | Cloudflare API Worker URL |
| `VITE_API_ORIGIN`   | `http://localhost:3000` | Cloudflare API Worker URL |

Only variables applicable to the selected Worker or build may be configured. A missing API Worker is
an explicit unavailable boundary, not permission to route the browser to a legacy host.

## Verification

Check the authoritative nameservers and intended web custom domain:

```sh
dig +short NS fidyapp.com
dig +short A fidyapp.com
dig +short AAAA fidyapp.com
curl --fail --silent --dump-header - https://fidyapp.com/ --output /dev/null
```

Verify that the root mail records remain owned by the approved mail provider. When an Email Worker is
introduced, provision its MX route through Cloudflare and verify that the Worker authenticates and
bounds forwarded content before handing off provider-neutral work. Do not create a Resend receiving
MX record or Resend webhook for inbound Fidy mail.
