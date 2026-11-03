# Manual Pro grants

For a small invited beta, Users register normally. An operator can then grant Pro indefinitely,
revoke that grant, or list current grants from the repository root:

```sh
bun run pro grant tester@example.com
bun run pro list
bun run pro revoke tester@example.com
```

Commands use existing Cloudflare D1 administrator authority, outside the public API, canonical
catalog, User-facing CLI and PATs. Before use, deploy migration `0007_pro_grants.sql` and the
matching application revision through the ordinary release process.

Configure these environment variables in the operator's secure local environment:

| Variable                | Value                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account containing the target database                |
| `CLOUDFLARE_API_TOKEN`  | Operator token with D1 Edit permission for that account          |
| `FIDY_DATABASE_ID`      | Exact target D1 database UUID from deployed infrastructure state |
| `FIDY_PRO_OPERATOR`     | Stable operator label, such as your work email                   |

The operator label records accountability; the Cloudflare token authorizes database access.
Keep the token out of arguments, source files and committed configuration. The command fixes the
Cloudflare API origin, validates database identifiers, bounds requests/responses and applies a
15-second request deadline. It sends no trace context and never retries automatically. Existing
metadata-only outbound policy applies; no extra telemetry exporter is needed for this short tool.

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
