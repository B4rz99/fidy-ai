# Bounded security drill — #1276 / #1262

Observed 2026-10-18. **Live drill incomplete; do not mark native detection, containment or recovery
verified.** The owner authorized the drill in chat. Restricted receipt `2b5542c7-4028-4a72-a32e-89d4de25a944`
records exact deployment IDs, times, bounded outcomes and immutable source identities. No secrets,
User identifiers or response payloads are published.

## Scope and observed outcome

The active public/Core release reported `08a6f1635a914bacfd8cc3847f94e3eaf47eb3ab`.
Read-only preflight established that production contains existing Users and a preexisting dead-letter
alert. Their state was preserved; an empty stack was not assumed.

A single capped burst of 104 anonymous `GET /categories` requests, concurrency four, ran from
20:43:12.820 to 20:43:20.439 UTC. It returned 60 authentication refusals (401) and 44 rate-limit
refusals (429). The rate protection was not bypassed. The Core observer needs 100 qualifying
refusals in one minute per observer; this exercise did not establish that threshold. Subsequent
read-only inspection found no native burst row or corresponding alert. Therefore absence of an
alert cannot be described as a proven detector failure.

The operational-health observation was stale at 17:15:01.390 UTC despite the every-minute cron
configuration. Configuration is not execution or health proof. Separate bounded malformed-bearer
probes returned 503; cause is not established from that response alone. No new test account or
grant was issued, and no production credential was revoked.

The owner suggested D1 quota exhaustion. Account-wide GraphQL analytics for the UTC date
2026-10-18 reported rows written above the [Workers Free daily allowance](https://developers.cloudflare.com/d1/platform/pricing/)
of 100,000. The quota hypothesis is consistent with the symptoms; no quota-specific failing
Worker write response was captured, and successful read-only console queries do not prove write
availability. Free allowances reset at 00:00 UTC (19:00 Colombia). No upgrade or quota-changing
action was performed. Production write tests stopped.

## Independently verified fallback and local checks

The existing [operator-alert workflow run](https://github.com/B4rz99/fidy-ai/actions/runs/39164628857)
succeeded. The authorized company inbox independently displayed its test message at 15:43 Colombia.
This establishes the CI/operator-mail transport for that run, not native security detection,
runtime D1-outage delivery or a human acknowledgement.

The focused local suites `core-rejection.test.ts`, `alert-delivery.test.ts` and `pats.test.ts`
passed: three files, 84 tests. They exercise isolated native D1/R2 fixtures, bounded detection,
notification failure/recovery and credential lifecycle controls. They do not establish live
scoped grant containment, stale-authority refusal, recovery or cleanup.

## Privacy disposition, cleanup and continuation

The bounded requests carried no credential or User identity and requested no authenticated User
data or product mutation. They establish no personal-data exposure in the exercise. Actual outage
impact and any reporting decision require their own scoped facts; no live incident report or
provider drill contact was submitted.

No User, credential, grant, migration, release or infrastructure was created or changed. No domain
data was repaired, deleted or replayed. Test traffic stopped; rate counters remain under their
existing expiry policy, whose removal was not independently observed. The preexisting dead-letter
alert was neither acknowledged nor resolved. The single test email remains as correspondence
evidence. Local fixture disposal belongs to the test harness.

After quota recovery, first verify fresh monitoring and D1-dependent operation, then rerun the
bounded security signal and an explicitly isolated grant containment/recovery path. Preserve rate
limits and existing real-User state. Link that actual result to the [privacy procedure](privacy-decisions-1276.md);
this partial receipt cannot close #1262 or #1276's technical handoff requirement.
