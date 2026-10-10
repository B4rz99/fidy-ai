# D1-independent operator alerts

- **Status:** Accepted (independent architecture review completed before implementation)
- **Date:** 2026-10-10
- **Issue:** #1160

## Context

D1 cannot own admission for the operator email that reports its own outage. #1140 already installed
conditional R2 claims in the private statement staging bucket. That path needs explicit acknowledgement,
provider ambiguity and recovery policy, and operational guidance reflecting its actual failure domain.

## Decision

Operational Health owns one bounded metadata-only R2 object, `operational/alerts/d1-v1`, in the
existing private `STATEMENT_STAGING_BUCKET`. R2 conditional writes, using the current ETag or
create-if-absent, serialize durable observation and notification admission. Every provider attempt
follows a successful claim. A losing concurrent tick sends nothing. There is no process-local ledger,
new binding, Durable Object, credential, recipient, public administrative route, or User authority.

The ledger retains only phase, observation/attempt timestamps, finite severity, acknowledgement,
confirmation, bounded attempt count and the original bounded release coordinate. Older observations
cannot regress it. A confirmed email repeats after 30 minutes for critical or four hours for warning.
A failed or ambiguous attempt retries at five-minute intervals, at most six times per identity,
retaining its original release and key for the existing 23-hour safe provider idempotency window.
After that window an eligible new identity permits further bounded operator-only attempts. An
in-flight or unconfirmed send is never assumed rejected. A late confirmation conditionally updates
only the exact claim that sent it.

The operator can acknowledge the exact firing ledger with a private conditional R2 write. This
suppresses firing repeats without claiming recovery. Only an explicit healthy D1 inspection can
start resolution; unknown or unavailable inspection cannot resolve. Resolution uses the same bounded
ambiguity policy. The firing cooldown survives resolution to bound rapid flapping. Confirmed resolved
state is retained as a single tombstone rather than deleted: deletion would remove the cooldown and
allow a storm. Each replacement overwrites the same bounded object; history does not accumulate.
Other operational alert coordinates retain their existing D1 ledger and acknowledgement policy.

## Failure domain and alternatives

This path survives unavailable D1 while Core execution, its minute trigger, R2 and the approved
Resend transport remain available. It cannot detect a stopped Core schedule, a Cloudflare-wide
outage, failed R2 access or provider/inbox failure. Provider acceptance is not proof of inbox receipt.
An independently scheduled external monitor is necessary for Core cron liveness. GitHub deployment
failure email remains independent but observes releases rather than runtime D1 availability.

A dedicated Durable Object would add an unnecessary binding and persisted owner when the existing
strongly consistent R2 conditional-write boundary can serialize one finite coordinate. D1-only claims,
process-local counters and provider idempotency alone cannot provide independent durable admission.
No production infrastructure or configuration is enabled by this decision.

## Verification

Use actual Miniflare R2, including persistence across runtime disposal/recreation, and the operational
inspection entrypoint with all D1 operations failing. Substitute only provider transport for delivery.
Cover concurrent claims, failure and lost response, retry exhaustion/window renewal, warning/critical
cooldowns, private acknowledgement, unknown inspection and healthy resolution, corrupted state and
cancellation. Existing D1 alert tests continue to protect ordinary alert policy.
