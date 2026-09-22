# External endpoints

Fidy's stable public namespace is decided in
[ADR-0002](../adr/0002-fidy-product-identity-and-public-namespace.md). This runbook records the
Cloudflare-owned endpoint boundary.

## Ownership and routing

- `app.fidyapp.com` is the canonical Cloudflare custom domain for the assets-only web Worker.
- `fidyapp.com` permanently redirects to `app.fidyapp.com` while preserving path and query.
- `api.fidyapp.com` reaches the public ingress Worker. Its `/health` route delegates to the private
  Core Worker through the `CORE` service binding; Core has no public hostname.
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
| `PUBLIC_WEB_ORIGIN` | `http://localhost:5173` | `https://app.fidyapp.com` |
| `PUBLIC_API_ORIGIN` | `http://127.0.0.1:8787` | `https://api.fidyapp.com` |
| `VITE_API_ORIGIN`   | `http://127.0.0.1:8787` | `https://api.fidyapp.com` |

`alchemy dev` supplies the browser's local API origin from the declared ingress port; it is the
representative local topology. Only variables applicable to the selected Worker or build may be
configured. An unavailable API Worker is not permission to route the browser to a legacy host.

## Verification

Check the authoritative nameservers and the complete public topology:

```sh
dig +short NS fidyapp.com
dig +short A app.fidyapp.com
dig +short AAAA api.fidyapp.com
curl --fail --silent --dump-header - https://fidyapp.com/ --output /dev/null
curl --fail --silent https://app.fidyapp.com/deployment-metadata.json | jq
curl --fail --silent https://api.fidyapp.com/health | jq
```

Verify that the root mail records remain owned by the approved mail provider. When an Email Worker is
introduced, provision its MX route through Cloudflare and verify that the Worker authenticates and
bounds forwarded content before handing off provider-neutral work. Do not create a Resend receiving
MX record or Resend webhook for inbound Fidy mail.
