# Deploy every trunk push directly

- **Status:** Accepted
- **Date:** 2026-11-23
- **Supersedes:** The release sections of [ADR 0026](0026-cloudflare-native-production-replatform.md)
  (trunk recheck before deploy, zero-traffic candidates, promotion and rollback eligibility,
  closed installation and deployment evidence).

Fidy is unreleased and has one environment. A push to `trunk` deploys each Alchemy stack whose
inputs changed with a plain `alchemy deploy --stage production`; pull requests show the
`alchemy plan` for the same stacks, and a failing plan blocks the merge. The application always
serves `app.fidyapp.com` and `api.fidyapp.com` with live providers. A revert is the rollback.

The gated release it replaces staged zero-traffic Worker versions behind closed admission on
separate acceptance hosts, verified them with release-smoke and fixture providers compiled into
the runtime, and promoted them by manual dispatch. It cost thousands of lines of release code and
runtime branches and still failed on ordinary pushes, while protecting no real Users.

## Consequences

- Worker code changes take all traffic at once. A revert never rolls back Durable Object SQLite
  state, alarms, queues, Workflow instances or R2 bytes, so storage migrations stay forward-only.
- Plans need the production credentials, so the `production` environment admits every branch of
  this repository; deploy jobs run only on `trunk`, and fork pull requests are never planned.
- The zone edge policy (HSTS and rulesets) lives in the site stack, which already owned it, and
  redeploys whenever server routes change.
- Reintroduce staged traffic, admission gates or a second stage only when real Users make a
  partial outage more expensive than the machinery.
