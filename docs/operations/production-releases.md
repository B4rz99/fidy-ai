# Production releases

Every push to `trunk` deploys the Alchemy stacks whose inputs changed. Nothing is dispatched by hand, there is no staged traffic and there is no separate acceptance host. [Decision](../adr/0063-deploy-every-trunk-push-directly.md)

| Stack | Entrypoint                         | Serves                                                   | Workflow               | Deploys when these change                                    |
| ----- | ---------------------------------- | -------------------------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| App   | `infra/cloudflare/alchemy.run.ts`  | `api.fidyapp.com`, `app.fidyapp.com`, Core, Email Worker | `deploy-app.yml`       | `apps/server`, `apps/web`, `infra/cloudflare`                |
| Site  | `infra/cloudflare/alchemy.site.ts` | `fidyapp.com` and the zone edge policy                   | `deploy-site.yml`      | `apps/site`, `apps/server` (edge routes), `infra/cloudflare` |
| Docs  | `infra/docs/alchemy.run.ts`        | `docs.fidyapp.com`                                       | `docs-publication.yml` | `apps/docs`, `infra/docs`, `design`, `tools/astro`           |
| CLI   | `scripts/cli-release/release.py`   | GitHub Releases                                          | `cli-release.yml`      | resolved CLI inputs                                          |

Shared inputs (`bun.lock`, `package.json`, `patches/`, `tsconfig*.json`, `.github/actions/`, `scripts/install-*.sh`) and each stack's own workflow file redeploy every stack that depends on them. Each stack has its own concurrency group, so deploys of the same stack queue in push order.

## Pull requests

**Checks** runs `alchemy plan --stage production` for every stack the PR touches, through `alchemy-stack.yml` in the GitHub `production` environment. The job summary shows the plan. A plan that fails blocks the merge; a plan that replaces or deletes resources does not, so read the summary before merging. Pull requests from forks never receive the production credentials and are not planned.

## Deploy and verify

`alchemy-stack.yml` installs the workspace, derives `HOSTED_AI_MODEL` and `CONTRACT_DIGEST`, and runs a plain `alchemy deploy --stage production`. It then requires `https://api.fidyapp.com/health` and `https://app.fidyapp.com/deployment-metadata.json` (app) or `https://fidyapp.com/deployment-metadata.json` (site) to report the pushed commit.

## Rollback

Revert the commit on `trunk`. The revert deploys like any other push. Durable Object SQLite state, alarms, queues, Workflow instances and R2 bytes are not rolled back; a revert of a storage migration needs its own forward migration.

## Human review

The beta Pro operator uses its separate 15-minute Access application at `/internal/beta-pro` with `BETA_PRO_OPERATOR_EMAIL=obarboza@fidyapp.com`. The recovery operator uses its own Access group and audience. Titular erasure has an independent audience and scoped custody procedure. The designated human IngestSample reviewer, `obarboza@fidyapp.com`, uses the distinct sample-review Access application at `/internal/sample-review`. The reviewer supplies their own short-lived Access identity. Inspect the redacted candidate privately and record the review outcome there. Keep assertions, source material and private identifiers out of CI artifacts and issue comments. An unassigned pricing-publish or billing-support audience should yield an unauthorized result. Receipt generation does not assign either human role.
