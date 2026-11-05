# Manual Pro grants

For a small invited beta, Users register normally. An operator can then grant Pro indefinitely,
revoke that grant, or list current grants from the repository root:

```sh
bun run pro grant tester@example.com
bun run pro list
bun run pro revoke tester@example.com
```

Commands use existing Cloudflare administrator authority through the deployed Core Worker's private
`ProGrantService` binding. The service exposes only grant, revoke and list commands, outside the
public API, canonical catalog, User-facing CLI and PATs. Deploy the matching Core revision and
schema through the ordinary release process before use.

Configure these environment variables in the operator's secure local environment:

| Variable                | Value                                          |
| ----------------------- | ---------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account containing Core             |
| `FIDY_CORE_WORKER_NAME` | Exact deployed Core Worker name                |
| `FIDY_PRO_OPERATOR`     | Stable operator label, such as your work email |

Authenticate Wrangler using its existing OAuth profile or a genuine `CLOUDFLARE_API_TOKEN` with
permission to access the Worker remote binding. The operator label records accountability; it
supplies no User authority. Keep credentials out of arguments, source files and committed
configuration. `FIDY_DATABASE_ID` must be unset: the command refuses this old direct-database
configuration. Core selects its single authoritative target; missing, mixed, inactive or retired
targets refuse without a database fallback. Its recovery and Erasure admission guards still apply.

The launcher builds the operator entry and runs it under Node, as Wrangler remote bindings require
Node's dispatcher. It creates a scoped, secret-free binding configuration and disposes the proxy
on completion. The command fixes the Cloudflare API origin, validates bounded commands and
responses, and applies a 15-second RPC deadline. It never retries a command automatically. A
request that loses its response may already have committed; run `list` before repeating a change.

Email lookup uses independently verified email credentials, normalized to lowercase. Provider
contact emails do not prove mailbox ownership and cannot select a User for a grant or revocation.
A tester can verify their email under Settings → Account. For a User without a verified email,
select their stable UserId explicitly. A missing or ambiguous match makes no change:

```sh
bun run pro grant --user-id 10000000-0000-4000-8000-000000000001
bun run pro revoke --user-id 10000000-0000-4000-8000-000000000001
```

Successful commands print JSON containing UserId and action. `list` returns active grants only;
it refuses more than 1,000 rows rather than reporting an incomplete list. After an uncertain
mutation response, run `list` before deciding whether to issue another change.

A grant applies to all normal Pro capability checks. It never creates a paid Subscription,
extends the original TrialPeriod, authorizes data processing, or changes existing billing.
Revocation removes only manual access: an active trial or paid Subscription still supplies Pro.
Grant/revocation events retain their order, operator and time, and cannot be updated in place.
They are deleted with the User during erasure. The product shows the ordinary Pro label without
a special beta label, trial countdown or purchase prompt while a grant is active. Reload or refresh
subscription status to observe a change; protected server actions always check current standing.
