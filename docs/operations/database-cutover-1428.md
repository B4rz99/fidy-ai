# Database redesign implementation contracts

Implementation prerequisite: [#1428](https://github.com/B4rz99/fidy-ai/issues/1428).
The authoritative feature specs remain [#1394's index](https://github.com/B4rz99/fidy-ai/issues/1394).
This checklist resolves cross-feature implementation obligations; it does not replace those specs.

## Status and release boundary

The feature-design pass is complete. Earlier instructions to wait for the whole design, and headings
calling the final workflow shapes proposed, describe earlier review stages. The concluding approval
establishes the design basis for tickets #1428–#1494. The current implementation request covers
#1428; publication of the remaining tickets is not authorization to execute them all. Design approval
does not establish migration equivalence, benchmark results, upload safety, platform coverage, or
deployment success.

The accepted inventory contains **101 distinct named target tables**, including four conditional
Transaction projections. Removing all four after measurement gives **97**. The recipient proposal
below is **not accepted or included**: approval would make these counts 102 and 98 respectively.
These are target counts, not a database inspection or a claim about Production.

Work stays on `refactor/schema-low-medium` for the coupled schema/code integration. Independent,
green slices may commit there; mechanically incomplete steps must not be released. The final
blocking verification ticket is [#1494](https://github.com/B4rz99/fidy-ai/issues/1494). Apply schema
changes with all affected owner implementations, triggers, readers, erasure adapters and fixtures.
No temporary extraction release, legacy-client compatibility layer, or destructive fresh-start of a
populated database is part of this contract.

## Target ownership

Each table below has one persistence owner. Feature consumers use that owner's published
operations; a foreign key does not grant cross-owner SQL access. Native owners below are under
`apps/server/cloudflare/`, except the portable SQL Assertions owner named explicitly. Counts exclude
generated columns, views, indexes, migration bookkeeping and provider-managed storage. Logical
erasure store IDs identify permissions, not extra tables.

| Spec                                                                                                           | Physical owner                                      | Target tables                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1396](https://github.com/B4rz99/fidy-ai/issues/1396)                                                         | Identity (`identity`)                               | `users`                                                                                                                                                                                                                                                                                                                                           |
| [#1397](https://github.com/B4rz99/fidy-ai/issues/1397)                                                         | Subscription (`subscription`)                       | `subscriptions`, `subscription_prices`, `payment_enrollments`, `payment_sources`, `billing_attempts`, `billing_provider_transactions`, `subscription_cancellations`, `refund_attempts`, `billing_price_notices`                                                                                                                                   |
| [#1398](https://github.com/B4rz99/fidy-ai/issues/1398)                                                         | Ingestion (`ingestion`)                             | `forwarding_addresses`, `statement_backfill_entitlements`, `forwarded_email_receipts`, `media_submissions`, `statement_staging_objects`, `statement_submissions`, `statement_materializations`, `statement_materialization_parts`, `statement_record_outcomes`, `ingestion_review_items`, `anonymized_email_samples`, `statement_review_capacity` |
| [#1395](https://github.com/B4rz99/fidy-ai/issues/1395)                                                         | Insights (`insights`)                               | `schedules`, `schedule_history`, `insight_events`, `insight_reports`, `proactive_messages`, `insight_offer_requests`, `weekly_question_requests`, `weekly_proactivity_state`, `reminder_proactivity_state`, `recurring_digest_items`, `proactive_transcript_entries`                                                                              |
| [#1399](https://github.com/B4rz99/fidy-ai/issues/1399)                                                         | Audit (`audit`)                                     | `audit_entries`, `audit_retention_permits`                                                                                                                                                                                                                                                                                                        |
| [#1400](https://github.com/B4rz99/fidy-ai/issues/1400)                                                         | OAuth Agents (`oauth-agents`)                       | `oauth_public_clients`, `oauth_review_requests`, `oauth_connections`, `oauth_credentials`                                                                                                                                                                                                                                                         |
| [#1400](https://github.com/B4rz99/fidy-ai/issues/1400)                                                         | OAuth Confirmation (`oauth-confirmation`)           | `oauth_operation_intents`                                                                                                                                                                                                                                                                                                                         |
| [#1401](https://github.com/B4rz99/fidy-ai/issues/1401)                                                         | Browser Login (`browser-login`)                     | `browser_login_pairings`                                                                                                                                                                                                                                                                                                                          |
| [#1401](https://github.com/B4rz99/fidy-ai/issues/1401)                                                         | WebSession (`web-session`)                          | `web_sessions`                                                                                                                                                                                                                                                                                                                                    |
| [#1402](https://github.com/B4rz99/fidy-ai/issues/1402)                                                         | Email Authentication (`email-authentication`)       | `verified_email_credentials`, `email_replacements`                                                                                                                                                                                                                                                                                                |
| [#1403](https://github.com/B4rz99/fidy-ai/issues/1403)                                                         | Provider Authentication (`provider-authentication`) | `provider_credentials`, `provider_authentication_attempts`, `whatsapp_provider_handoffs`                                                                                                                                                                                                                                                          |
| [#1404](https://github.com/B4rz99/fidy-ai/issues/1404)                                                         | Recovery (`recovery`)                               | `backup_recovery_credentials`, `support_recovery_cases`                                                                                                                                                                                                                                                                                           |
| [#1405](https://github.com/B4rz99/fidy-ai/issues/1405)                                                         | Resource Admission (`resource-admission`)           | `resource_admission_grants`, `resource_admission_events`, `resource_admission_counters`                                                                                                                                                                                                                                                           |
| [#1405](https://github.com/B4rz99/fidy-ai/issues/1405)                                                         | Canonical Admission (`canonical-admission`)         | `canonical_request_buckets`, `canonical_request_leases`                                                                                                                                                                                                                                                                                           |
| [#1406](https://github.com/B4rz99/fidy-ai/issues/1406)                                                         | Quotas (`quotas`)                                   | `commercial_allowance_consumptions`                                                                                                                                                                                                                                                                                                               |
| [#1407](https://github.com/B4rz99/fidy-ai/issues/1407)                                                         | Tokens (`tokens`)                                   | `pats`, `pat_pairings`                                                                                                                                                                                                                                                                                                                            |
| [#1408](https://github.com/B4rz99/fidy-ai/issues/1408)                                                         | Transactions (`transactions`)                       | `transactions`, `source_attestations`, `transaction_corrections`, `transaction_reconciliation_decisions`                                                                                                                                                                                                                                          |
| [#1409](https://github.com/B4rz99/fidy-ai/issues/1409)                                                         | Categories (`categories`)                           | `categories`, `keyword_rules`                                                                                                                                                                                                                                                                                                                     |
| [#1410](https://github.com/B4rz99/fidy-ai/issues/1410)                                                         | Budgets (`budgets`)                                 | `budgets`, `budget_month_plan_records`, `budget_month_latches`, `budget_threshold_alerts`, `budget_user_state`, `budget_evaluation_work`, `budget_publications`                                                                                                                                                                                   |
| [#1411](https://github.com/B4rz99/fidy-ai/issues/1411)                                                         | Transactions (`transactions`), conditional          | `transaction_projection_leaf`, `transaction_projection_bucket`, `transaction_projection_digit`, `transaction_projection_state`                                                                                                                                                                                                                    |
| [#1411](https://github.com/B4rz99/fidy-ai/issues/1411), [#1413](https://github.com/B4rz99/fidy-ai/issues/1413) | User Documents (`user-documents`)                   | `user_documents`                                                                                                                                                                                                                                                                                                                                  |
| [#1412](https://github.com/B4rz99/fidy-ai/issues/1412)                                                         | Recurring (`recurring`)                             | `recurring_series`, `recurring_evaluation_records`, `recurring_dispatch`                                                                                                                                                                                                                                                                          |
| [#1414](https://github.com/B4rz99/fidy-ai/issues/1414)                                                         | Connections (`connections`)                         | `connections`, `connection_attempts`                                                                                                                                                                                                                                                                                                              |
| [#1415](https://github.com/B4rz99/fidy-ai/issues/1415)                                                         | Consent (`consent`)                                 | `consent_offers`, `consent_history`, `pending_consent_exchanges`                                                                                                                                                                                                                                                                                  |
| [#1416](https://github.com/B4rz99/fidy-ai/issues/1416)                                                         | Agent (`agent`)                                     | `hosted_agent_sessions`, `hosted_turns`, `hosted_confirmations`, `hosted_mutation_commits`, `transcript_entries`                                                                                                                                                                                                                                  |
| [#1417](https://github.com/B4rz99/fidy-ai/issues/1417)                                                         | Memory (`memory`)                                   | `memories`                                                                                                                                                                                                                                                                                                                                        |
| [#1418](https://github.com/B4rz99/fidy-ai/issues/1418)                                                         | WhatsApp (`whatsapp`)                               | `whatsapp_service_windows`, `whatsapp_deliveries`, `whatsapp_event_records`                                                                                                                                                                                                                                                                       |
| [#1425](https://github.com/B4rz99/fidy-ai/issues/1425)                                                         | Erasure (`erasure`)                                 | `erasure_requests`, `erasure_steps`, `erasure_custody_records`, `erasure_permits`, `erasure_control`, `erasure_restore_members`                                                                                                                                                                                                                   |
| [#1427](https://github.com/B4rz99/fidy-ai/issues/1427)                                                         | Canonical Admission (`canonical-admission`)         | `canonical_request_replays`                                                                                                                                                                                                                                                                                                                       |
| [#1427](https://github.com/B4rz99/fidy-ai/issues/1427)                                                         | SQL Assertions (`src/shell/sql-assertions`)         | `sql_assertions`                                                                                                                                                                                                                                                                                                                                  |
| [#1427](https://github.com/B4rz99/fidy-ai/issues/1427)                                                         | Canonical Operations (`canonical-operations`)       | `canonical_child_guard`                                                                                                                                                                                                                                                                                                                           |

Dashboard owns its document codec and view policy; Recurring Planning owns its document codec and
planning decisions. User Documents owns the common `(user_id, kind)` persistence and optimistic
revision write. There is one physical table, not a table per consumer. Operations #1426 owns no
application table; platform observability and exact-revision CI replace its stores only after the
coverage gates pass. Onboarding composes owners and owns no persistent table.

## Recipient routing: explicit review gate

**Proposed, awaiting User review:** `whatsapp_recipients`, owned by WhatsApp, one current route per
User. This is a newly identified table, not an accepted addition to #1418. Do not implement it or
remove the source fields before approval. [#1483](https://github.com/B4rz99/fidy-ai/issues/1483) and
the route-dependent part of [#1485](https://github.com/B4rz99/fidy-ai/issues/1485) remain gated.

| Column                     | SQL type                  | Contract                                                                |
| -------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `user_id`                  | TEXT NOT NULL PRIMARY KEY | `UserId`; references `users.id`                                         |
| `portfolio_id`             | TEXT NOT NULL             | `WhatsAppBusinessPortfolioId`; exact observed recipient portfolio       |
| `bsuid`                    | TEXT NOT NULL             | `WhatsAppBusinessScopedUserId`; exact observed recipient                |
| `business_phone_number_id` | TEXT NOT NULL             | `WhatsAppBusinessPhoneNumberId`; sending endpoint                       |
| `verified_at_ms`           | INTEGER NOT NULL          | Original authenticated receipt instant; preserve current integer bounds |

Copy the four complete `users.route_*` fields exactly and use `users.id` as `user_id`. Complete
absence produces no recipient row. Partial groups block migration. Preserve the current update
comparison `incoming_received_at_ms >= verified_at_ms`, including equal-time behavior. The channel
must prepare the write inside the authenticated inbound/decision batch and recheck Identity's
current `(UserId, PortfolioId, BSUID)` association there. Reading a route is not authorization;
egress must independently recheck current association and applicable Consent/queued-work authority.
Do not repair historical route/association mismatches by rebinding their owner or fabricating proof.

The proposed table has no login authority, window timestamp, delivery history, public operation,
new expiry policy or sandbox phone fallback. Existing route erasure remains channel-owned under
the `insight_whatsapp_routes` logical purpose until the full-deletion cutover replaces that adapter.
Historical Consent recipients and already-started deliveries retain their own frozen bindings.

Why a separate record: `sweepExpiredWhatsAppWindows` deletes expired windows in bounded pages,
whereas `prepareInsightRecipient`/`findInsightRecipient` retain and read routes independently.
Template delivery can need a route after a window expires. A Turn, individual delivery or pre-User
exchange has neither the current-route cardinality nor its lifetime. Adding route fields to windows
would change the accepted window cleanup contract; deriving a route from the latest delivery would
lose an authenticated observation with no outgoing delivery. Keeping the fields on `users` would
leave the accepted Identity separation unfinished.

Source evidence: [recipient operations](../../apps/server/cloudflare/whatsapp/internal/insight-delivery.ts),
[window cleanup](../../apps/server/cloudflare/whatsapp/internal/whatsapp-turn.ts), and
[channel erasure](../../apps/server/cloudflare/whatsapp/internal/erasure.ts).

## Typed identities and relational contracts

Use existing owning schemas at runtime boundaries. SQL TEXT storage does not make two key types
interchangeable. Preserve the existing UUID spelling/opaque references; migration must not assign
replacement IDs to force a join. INTEGER instants use UTC milliseconds; lossless ISO conversions
must round-trip to the exact original instant. Missing timestamps stay absent. Sequences and
revisions are not timestamps; Money uses its existing exact Currency-qualified codec.

| Identity                | Existing declaration or qualification                                                        | Required relational key                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| User                    | `UserId`, `core/identity/contract.ts`                                                        | `users(id)`; dependent public reads/writes carry the stable User                                                |
| WhatsApp association    | `WhatsAppBusinessPortfolioId`, `WhatsAppBusinessScopedUserId`, `core/identity/contract.ts`   | Unique `(whatsapp_portfolio_id, whatsapp_bsuid)`; all three association fields absent or complete               |
| Business endpoint       | `WhatsAppBusinessPhoneNumberId`, `core/identity/contract.ts`                                 | Routing/proof evidence only; never a User lookup fallback                                                       |
| Pre-User Consent        | `PendingConsentExchangeId`, `core/consent/contract.ts`                                       | `pending_consent_exchanges(id)`; no synthetic User reference                                                    |
| Onboarding grant        | `OnboardingConsentGrantId`, `core/consent/contract.ts`                                       | UUID chat grant or original 43-character web provider-attempt reference; do not narrow all Consent IDs to UUIDs |
| Notification grant      | `ConsentRecordId` plus history record type/category                                          | Unique same-User, type-qualified parent; never a bare `id` join across history variants                         |
| Hosted Session / Turn   | `HostedAgentSessionId` / `TranscriptTurnId`, `core/agent/contract.ts`                        | Unique `(user_id,id)` on each parent; Turn references `(user_id,hosted_session_id)`                             |
| Browser session         | `WebSessionId`, `core/web-session/contract.ts`                                               | Unique `(user_id,id)` plus unique consumed pairing; session proof remains live at use                           |
| InsightEvent / schedule | `InsightEventId` / `ScheduleId`, `core/insights/contract.ts`                                 | Event `(user_id,id)`; instruction revision `(user_id,kind,schedule_id,version)`                                 |
| Message                 | Existing `ProactiveDeliveryId` for proactive IDs; retain existing weekly IDs and closed kind | Unique `(user_id,kind,id)`; role further qualifies reference validity                                           |
| Transcript              | `TranscriptEntryId` for hosted entries; preserve proactive kind-qualified IDs                | Hosted sequence orders retained conversation; proactive unique `(user_id,kind,id)` remains a distinct namespace |
| Subscription / price    | `SubscriptionId` / `PriceId`, `core/subscription/contract.ts`                                | `subscriptions(id)` and unique `user_id`; immutable `subscription_prices(id)`                                   |
| Enrollment / attempt    | `PaymentEnrollmentId` / `BillingAttemptId`, `core/subscription/contract.ts`                  | Unique `(subscription_id,id)` parent candidates; source UUID remains distinct from enrollment UUID              |
| Shared document         | Closed `dashboard` or `recurring-plan` kind                                                  | Primary `(user_id,kind)`; encoded body does not supply the authoritative revision                               |

The source paths in this table are relative to `apps/server/src/`. Owner declarations remain the
source of key validation; this document introduces no duplicate TypeScript schemas or public row
types. Where SQL cannot name a constant type discriminator directly in a composite foreign key,
retain a generated variant-qualified helper and its unique parent key. Its expression must yield
NULL for other variants. CHECK constraints still enforce complete required groups: a nullable
composite foreign key alone does not reject a partially populated reference.

### User extraction and onboarding

| Extraction                           | Final destination / key                                            | Atomic obligation                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trial and fixed WhatsApp association | `users(id)`                                                        | Preserve the original trial and optional association; never reset them for returning authentication                                                      |
| Stable paid identity / standing      | `subscriptions(id,user_id,current_paid_attempt_id)`                | Copy existing Subscription UUID; never create one merely because a User exists; current attempt belongs to this Subscription and has verified paid facts |
| Cancellation                         | `subscription_cancellations(subscription_id)`                      | Preserve exact detached source/paid attempt, paid-through snapshot, send claim and budgets independently of current standing                             |
| Forwarding                           | `forwarding_addresses(user_id)`; unique `id` and `local_part`      | Issue with the processing grant; copy existing identifiers/issue time without issuing addresses to other Users                                           |
| Backfill                             | `statement_backfill_entitlements(user_id)`                         | Row absence remains absence; validate same-User submission; reserve/release/consume with the submission transition                                       |
| Mailbox                              | `verified_email_credentials(user_id)`; normalized unique `address` | Replacement validates prior credential snapshot and fresh session, installs the new credential and consumes proof together                               |
| Recovery                             | `backup_recovery_credentials(user_id)`; unique `code_digest`       | Preserve digest bytes/revision/consumption; approval and code use commit together; never disclose a migrated code                                        |
| Recipient                            | Proposed `whatsapp_recipients(user_id)`                            | Approval gate above; channel update and identity recheck remain in one unit                                                                              |
| Ordinary Audit cutoff                | `audit_retention_permits(user_id)`                                 | Acquire, assert, delete only eligible kinds before cutoff, and clear in one batch; retained source permits are an anomaly to investigate                 |

`completeEnrollment` remains a composition of published owner preparations. In one D1 batch:
create Identity/trial; append original Consent; install the recovery digest; establish the provider
credential and any initial WhatsApp association; bind/consume the exact originating attempt,
pairing, exchange and handoff as applicable; assert final proof/current state. The existing proof
owner determines the executable statement order. No owner preparation commits by itself. Recovery
plaintext leaves only the successful immediate no-store response. Browser Login alone subsequently
creates a WebSession with the independent browser verifier.

Returning authentication retains the existing User/trial/Consent/recovery records. Initial channel
linking cannot replace an established association. Provider contact email cannot create a mailbox
credential. `provider_credentials(issuer,subject)` remains unique independently of contact email.
Provider attempt and handoff references keep their existing opaque encodings and one-use uniqueness.

### Consent, messages, reports and Audit

| Child/reference             | Required same-owner/type binding                                                             | Lifecycle constraint                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Consent offer               | `(user_id,kind,id)` candidate over primary `(kind,id)`                                       | `replaces_offer_id` stays in the same User/category; weekly source and rejection keys keep their separate meanings                            |
| Consent history             | Stable `sequence`; original type-qualified identities and narrower unique scopes             | Grant/revoke/renew/withdraw references target the appropriate record type and User; missing original IDs stay missing                         |
| Offer-backed grant          | History kind/category selects the exact `(user_id,kind,offer_id)`                            | Preserve generated weekly/proactive offer references where required; never point a weekly grant at a category offer                           |
| PAT/OAuth Consent           | Exact same-User PAT/pairing or OAuthConnection identity                                      | Preserve automatic-policy versus authenticated-human origin and historical disclosure bytes/revision                                          |
| Schedule revision/execution | `(user_id,kind,schedule_id,version)` parent revision                                         | Occurrence replay additionally binds the original scheduled instant; digest-day identity includes local date and both UTC midnight boundaries |
| Financial report            | `insight_reports(user_id,insight_event_id)` candidate; `kind` selects payload                | References exact same-User event; no duplicate mutable event-to-report pointer; report may outlive rendered message text                      |
| Message report link         | `(user_id,report_event_id)` to report                                                        | Required for weekly-summary/recurring report roles; absent for standalone offers/questions without a financial occurrence                     |
| Event grouped-message link  | `(user_id,message_kind,message_id)` to message                                               | Multiple genuine events may share a message; no fabricated event to satisfy a question/offer relationship                                     |
| Proactive transcript link   | `(user_id,transcript_kind,transcript_id)`; delivery link is kind-qualified                   | Preserve ordering, original IDs and independent content expiry; do not collapse this store into Memory or hosted Transcript                   |
| WhatsApp delivery           | Same-User event, proactive message, weekly request or hosted Turn according to delivery kind | Weekly-question work references `weekly_question_requests`, not a fabricated financial report or message                                      |
| Hosted status callback      | Generated hosted-only correlation key in `whatsapp_deliveries`                               | Non-hosted correlation cannot satisfy the callback FK; provider evidence does not itself complete a Turn                                      |
| Audit activity              | Original subject, caller references, operation/outcome and sequence/id                       | A browser session plus affected PAT is valid attribution; do not enforce a universal exactly-one-actor rule                                   |
| Refresh lineage             | `(user_id,connection_id,replacement_refresh_id)` to refresh-kind credential                  | Unique successor; no self-link; immutable consumption time and connection; install with old consumption/new issuance                          |
| Support recovery evidence   | Original case/operator/state/times                                                           | Derive only after proving event cardinality and actor/time equality; preserve exceptions or block conversion                                  |
| Reminder control receipt    | Same-User reminder-question message, unique `(user_id,control_message_id)`                   | Keep exact accepted choice including question identity; replay remains valid after governor clears its question pointer                       |

The report candidate key is unique across its two allowed kinds because a report belongs to one
event. Preserve kind checks on that event/report binding; matching User/event IDs alone cannot
authorize a weekly payload on a recurring event. Where the existing payload embeds header/context,
prove equality before deriving away duplicate fields. Content-only historical reports need no new
live send. Unmatched reminder evidence, receipts, lineage or legal disclosures block migration;
do not create placeholder parents or invent timestamps.

Ordinary Audit expiry stays 365 days for `session_call`, `credential_call`, `insight_call` and
`publication`, with strict `< cutoff_ms`. Request admission metadata retains its separate 93-day
cleanup; support Recovery retains 24 calendar months after terminal closure. OAuth lineage and
reminder control receipts cannot expire through ordinary Audit cleanup. Account deletion supersedes
these ordinary retention purposes as described below.

### Cycles and implementation order

Four groups need integrated conversion rather than independent feature releases:

1. **Subscription:** Subscription current-paid pointer → BillingAttempt → enrollment/source →
   Subscription, and enrollment ↔ original source. Allocate/copy parent identities first; copy full
   source/enrollment/attempt sets before validating the paid pointer. Use same-Subscription candidate
   keys on both edges. Nullable current standing is not permission to omit historical paid access.
2. **Ingestion:** staging ↔ published submission, submission ↔ backfill reservation, and hosted
   origin ↔ attached statement. Preserve all original IDs and capture the same-User candidate keys
   before rebinding. Cache parts become children of materialization without deleting outcomes.
3. **Consent/credentials:** Consent proof, pairing, PAT/OAuth grant and referenced history may be
   created together. Preserve typed generated keys; do not weaken FKs to accommodate insertion order.
   Pre-User exchange deletion must not cascade into retained legal evidence or stable credentials.
4. **Insights:** event → message → report → event, plus transcript links and offer-backed message
   references. Install the whole parent key set and deferred references in one native migration;
   publish report/event/message/ready work as one owner commit, with offer/grant checks composed
   through Consent and provider evidence through WhatsApp.

For each group, use a native migration with deferred FK validation at the transaction boundary and
checked historical backfill. Prove the exact D1 migration/batch behavior in the existing migration
harness before choosing the statement order. Do not assume an interactive SQL transaction or a
PRAGMA in a separate HTTP call affects a later batch. Cross-owner references remain relational
constraints; runtime owner dependencies use published preparation/projection operations and keep
the import graph acyclic. Temporary migration staging tables, if needed inside the transaction,
are not new application stores and must not survive a committed slice.

## Full deletion and existing archives

[#1425](https://github.com/B4rz99/fidy-ai/issues/1425) supersedes selective retention for account
deletion. Earlier feature-spec archive-preservation wording protects historical meaning during
ordinary schema changes; it does not authorize new content copies after deletion. Live financial,
Consent, billing, recovery and delivery evidence still follows its existing ordinary retention until
its applicable deletion/expiry. No general retention shortening is authorized by this ticket.

Do not drop `erasure_archives`, clear archive-reference fields, delete recovery registry objects or
remove hold-aware triggers as an incidental feature cleanup. Their final removal belongs to
[#1489](https://github.com/B4rz99/fidy-ai/issues/1489) and
[#1490](https://github.com/B4rz99/fidy-ai/issues/1490), after prefix/write-bound proofs in #1486/#1487
and bounded deletion in #1488. The accepted end state has no retained-content archive reader/writer.

### Conversion of retained erasure data

The cutover must run under a maintenance/recovery fence that stops ordinary admissions, new file
capabilities, old archive writers and old background consumers. Never run old selective-retention
workers concurrently with the new erasure state machine. Resume only the final coherent code and
schema after generation reconciliation. External object deletion is irreversible and cannot be
rolled back by SQL; the conversion must be resumable across a crash between R2 and D1 actions.

1. **Establish the complete request set.** Reconcile D1 requests/steps/archives/objects/custody and
   restore members against every independent `recovery/cases/` entry. Decode and compare request ID,
   User ID, original requested instant and reviewed decision. A missing User row is valid after
   deletion; a missing or conflicting request/independent marker is a blocker. Do not infer expected
   membership only from surviving D1 requests.
2. **Classify admission before destructive work.** Reviewed requests with an established same-User
   deletion intention convert to full deletion, including old Complete/ExternalPending requests
   with retained content. Preserve their request/User IDs and requested instant; reset local
   completion and re-enter Draining. An AwaitingReview intention with no established completion
   authority, unmapped archive owner, unexplained legacy hold or conflicting decision stops
   conversion for explicit resolution. Do not mark it approved, delete its evidence or silently
   exclude it from the supported restore set. The final migration gate requires these exceptions
   resolved; no new legacy state is added to the target schema.
3. **Publish minimal independent deletion markers first.** Include the original request/User
   identities, requested instant and required generation/restore enforcement facts, using bounded
   decoded metadata. Confirm durable write/read-back under conditional generation control and
   retain independently enumerated expected membership. A marker must recreate deletion even when
   that request is absent from a restored D1. Publish before purging old cases or content; never
   reset the registry to `initial` or replace a missing checkpoint with an empty registry.
4. **Drain and delete under the new authority.** Establish a proven `writes_quiescent_after_ms`
   independently of scheduler continuation time, including restored/previously completed cases.
   Delete source records and all User prefixes in every configured bucket. Use existing object
   locators to delete legacy objects outside those prefixes before removing their inventory.
   Retry ambiguous deletions and re-list after quiescence; an empty pre-drain listing is not proof.
5. **Remove old retained copies, without reimporting them.** For each mapped request, delete its
   `erasure_archives` rows in bounded permit-authorized batches. Sweep the independent
   `held-records/<request>/`, `held/<request>/` and `recovery/objects/<request>/` key spaces used by
   the installed legacy writers. A legacy locator may be used transiently to find an original,
   then is deleted; do not copy it into new markers. Confirm original and retained objects absent
   before discarding the final locators. Missing/foreign/malformed locators stop conversion rather
   than broaden a deletion prefix. Old live records with no deletion request are migrated
   losslessly by their owner.
6. **Retire old controls last.** Once minimal markers and new restore release are verified, remove
   full `recovery/cases/` payloads, hold/archive-only controls and old preserve/import triggers.
   Drop the obsolete tables only after all their mapped payloads are disposed and no old reader
   or writer remains. Preserve bounded relevant deletion acknowledgments; do not carry erased
   content or selective-retention payloads into custody JSON. `Accepted` and unresolved provider
   outcomes still cannot become `Verified` or Complete by conversion.
7. **Prove restoration and release.** Restore a populated pre-cutover snapshot in the native
   harness, apply the target schema/code, then enumerate independent markers, recreate missing
   requests, re-fence producers and reapply database/file deletion. Generation equality, complete
   expected membership, exact User/generation matches and local cleanup are required before normal
   activity resumes. External cleanup may remain honestly pending. Never run a restored old binary
   that can reimport retained content or dispatch old provider work.

The prefix spellings in step 5 are migration inputs, not proposed new storage layout. Check all
configured buckets and actual legacy key constructors; abort if they disagree with this list.
Unowned retained objects require explicit reconciliation, never a bucket-wide blind purge. Do not
emit row bodies, object keys, User identifiers or disclosure material into public telemetry while
performing the census or handling failure. The current key constructors are
[held records](../../apps/server/cloudflare/erasure/internal/held-records.ts),
[held originals](../../apps/server/cloudflare/erasure-store/internal/original-holds.ts),
[original locators](../../apps/server/cloudflare/erasure-store/internal/original-checkpoint.ts), and
[reviewed cases](../../apps/server/cloudflare/erasure/internal/checkpoint.ts).

Existing backup horizons are not shortened by conversion. #1490 must establish a supported horizon
and bounded marker/control cleanup: remove the final deletion marker only once no supported backup
can resurrect that User and applicable external cleanup is complete. The current 7/30-day policy
constants are not evidence of provider backup configuration. Until that evidence exists, the
conversion cannot assert a safe marker expiry or successful deployment.

Migration evidence must account for each old archive row by its original request/store/row reference
before deletion. Logical field counts do not justify dropping historical references during an
earlier feature move. After full deletion is implemented, no archived-content restoration path or
archive-address-only physical column remains merely to preserve the superseded mechanism.

## Implementation checklist and gates

| Tickets     | Integrated boundary / release evidence                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1429–#1435 | Shared transaction enforcement and Resource Admission composition before migrated security-counter callers; preserve `changes()` sequencing and native CHECK attribution                    |
| #1436–#1448 | Audit/Consent/authentication extractions with public onboarding, replacement, recovery, OAuth and PAT callers; no partially established identity or consumed proof on refusal               |
| #1449–#1456 | Subscription sources/paid standing/cancellation/refund/notice plus Quotas; preserve immutable periods, retry identities, provider uncertainty and original cumulative budgets               |
| #1457–#1463 | Forwarding, parsed cache, review and backfill plus Transaction history; preserve review IDs, irreversible evidence expiry, exact Money and capture replay                                   |
| #1464–#1466 | Measure direct financial reads and select projection design; deleting projection state must retain a Transaction-owned fact revision, original first-capture instant and zone for Recurring |
| #1467–#1476 | Planning bounds, Budgets and fair User clock, weekly Recurring detection, Insights/report/message split and Audit evidence finalization; shared document counted once                       |
| #1477–#1485 | Memory, hosted enforcement/Transcript, WhatsApp proof/window/delivery/route, Connections and final Identity cleanup; route removal remains pending the review above                         |
| #1486–#1490 | Prefix discovery and enforced upload completion bounds, fixed bounded SQL selection, archive transition/full deletion and independent restore replay                                        |
| #1491–#1493 | Demonstrated platform alert/metric/dashboard coverage and exact-revision deployment verification before deleting custom operational state                                                   |
| #1494       | Final populated migration, meaningful integrated behavior, native atomic rollback/restore, dependency/publication/format/lint/typecheck and measured cost gates before release              |

These rows group work for navigation; the published tickets' native blocking edges define scheduling,
not a blanket requirement to run each numeric range sequentially. In particular, coupled schema and
caller work can assemble on the integration branch but must pass its final green gate together.

The [#1464 financial-read comparison](../research/financial-projection-comparison.md) selects the four
Transactions-owned projection tables for #1465. Preserve authoritative fact revision, original first
capture and timezone on their state row. Rename the stores, convert true instants and validate exact
maximum reconstruction; the measured write amplification and repair cost remain explicit tradeoffs.
Historical maximum/digit coordinates use a fixed four-decimal scale, not Currency-specific minor units.

Accepted workflow reductions retain their proof gates: Insights uses a generation-fenced native
digest scan; Recurring uses bounded native cursor checkpoints; Budgets uses one fair User discovery
clock. Do not remove fairness, prelaunch cooldown or cumulative provider/restart budgets based only
on Workflow step success. Keep Cloudflare Workflows as the durable engine with normal Effect inside
steps; no Effect WorkflowEngine or generic jobs table is introduced.

For each feature conversion, adapt existing public-operation/integrated workflow tests and populated
native migration checks. Show original identities, exact instants/Money, null/absent history,
foreign-key relationships and immutable snapshots survive; prove cross-User refusal and atomic
rollback where those boundaries change. For historical evidence not fitting the target, fail the
migration before destructive source removal and report the precise discrepancy. Remove obsolete
duplicate tests when their behavior is replaced; add no schema inventories, removal-only assertions,
parallel test registry or test-only interface.

This prerequisite records contracts and leaves runtime/migration work with the tickets above. No
runtime behavior changes here, so no new behavior test or migration is justified for #1428 itself.
The routing review remains open; do not close #1428 or release its dependent route extraction as
fully resolved until that decision is recorded.

## Replay acceptance cutover (#1430)

Canonical Admission derives the retry deadline from `accepted_at_ms + 86400000`. A record is live
only while `accepted_at_ms > current - 86400000`; equality expires it, permits key reuse and makes
it eligible for bounded cleanup. Neither completion nor disclosure restarts the window. The
acceptance index supports cleanup without scanning live response bodies. This changes no authority,
allowance, pending-work or response-preservation policy.

The single baseline contains the final shape. An existing development database needs a fenced,
transactional table rebuild before the matching Worker becomes active; editing the applied baseline
alone does not perform that conversion. Back up first and refuse conversion if any original
`expires_at_ms` differs from `accepted_at_ms + 86400000`. Keep the original `accepted_at_ms` exactly;
do not reconstruct it from deployment time or retry time. Copy `rowid` along with all ten retained
columns so existing erasure selection references remain stable. Preserve pending/completed state,
response bytes, status and content type, both digests, User, operation and execution identity.
Recreate the acceptance index and all replay erasure triggers from the target baseline in the same
transaction. Existing retained erasure snapshots remain historical evidence; newly captured snapshots
use acceptance time without the redundant expiry. Verify foreign keys and retained values before
aligning the applied ledger. Roll back the whole conversion on any discrepancy, and keep ordinary
admissions fenced through the code/schema cutover rather than serving old replay SQL against the
new table.

## Email admission counters (#1432)

The single baseline now installs `resource_admission_counters` instead of `email_security_limits`.
Resource Admission owns the shared counter statements, projections and erasure adapters. Email owns
eligibility, proof creation, non-enumerating refusal and delivery. Existing logical erasure store IDs
`browser_pairing_email_user_limits` and `email_replacement_limits` remain unchanged, including their
credential disposition and row references. Global capacity has no fabricated User and is not erased
with an individual User.

For an existing database, fence email login/replacement and erasure first and back up the database.
Refuse a pre-existing target table or any unexplained foreign-key inconsistency. Assemble **one native
transactional batch**: create the target table from the current baseline; execute the copy/verification
below; drop the old table; then install the target index and its six erasure triggers from that same
baseline. Dropping the source removes its original index and same-named triggers. Do not install new
triggers over those names before dropping the source. Do not publish matching Workers until the whole
batch succeeds. Ordinary database migration deployment does not rewrite an already applied baseline.

Copy original `rowid`, User, count, anchor and replacement work binding exactly. Compute the original
one-hour or 24-hour deadline from that original anchor, never from cutover time. The target constraints
reject unsupported policies, counts, scope/owner mismatches, lost work bindings, orphan Users and
unrepresentable deadlines. The following block is exercised against populated native D1 by the
Resource Admission conversion tests.

<!-- email-counter-copy:start -->

```sql
INSERT INTO resource_admission_counters
  (rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id)
SELECT rowid,
  CASE kind WHEN 'pairing' THEN 'email.pairing.user.v1'
    WHEN 'pairing-global' THEN 'email.pairing.global.v1'
    WHEN 'replacement' THEN 'email.replacement.user.v1' END,
  CASE WHEN kind='pairing-global' THEN 'global' ELSE user_id END,
  'anchored',window_started_at_ms,
  window_started_at_ms+CASE WHEN kind='replacement' THEN 86400000 ELSE 3600000 END,
  requests,last_work_id,user_id
FROM email_security_limits;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'email_counter_cutover',CASE WHEN
  (SELECT count(*) FROM email_security_limits)=(SELECT count(*) FROM resource_admission_counters)
  AND NOT EXISTS (
    SELECT 1 FROM email_security_limits old
    LEFT JOIN resource_admission_counters next ON next.rowid=old.rowid
    WHERE next.rowid IS NULL OR next.owner_user_id IS NOT old.user_id
      OR next.used IS NOT old.requests OR next.last_work_id IS NOT old.last_work_id
      OR next.window_start_ms IS NOT old.window_started_at_ms
      OR next.window_ends_ms IS NOT (old.window_started_at_ms+
        CASE WHEN old.kind='replacement' THEN 86400000 ELSE 3600000 END)
  ) AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
  THEN 1 ELSE 0 END
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='email_counter_cutover';
DROP TABLE email_security_limits;
```

<!-- email-counter-copy:end -->

If copying, verification, dropping the old table or installing any target object fails, roll back the
whole batch. Verify foreign keys, both original logical erasure permissions and stored anchors/counts
before aligning the sole-baseline ledger. A quota refusal leaves this cutover pending; it is not a
reason to deploy new SQL against the old schema. #1433 and #1435 extend the same target store only when
their PAT/calendar consumers and populated conversions land; their unused indexes are not installed
in advance.

## PAT admission (#1433)

PAT pairing sources now use `pat.pairing.source.v1` anchored counters. The scope is the lowercase
hex encoding of the original 32-byte keyed digest, never an address or a fabricated User. Reviews
use `pat.review.session.v1` rolling events with the original review identity as the one-claim grant
identity, original millisecond instant, and exact WebSession and User. Resource Admission owns
retention and the credential erasure projection under the unchanged `pat_review_attempts` logical
store ID. Ordinary shared schedule erasure excludes this credential policy. Erasing one review
never deletes another policy's charge or its still-shared grant.

For a populated database, fence PAT creation/review, admission writers, retention and erasure and
back up D1. Complete #1432 first. Refuse unexplained foreign keys, target policy collisions,
missing/foreign sessions, unrepresentable deadlines or an unfinished erasure chunk. Drain that
recoverable chunk with the old code before retrying; never reuse its old row selections against the
new physical store. Historical credential archives retain their original request/store/reference
and `{}` payload; credentials have no archived-content restoration. Shared existing event and email
counter rowids remain exact. PAT review IDs remain exact; their new physical rowids are not grant
identities or references to previously archived content.

Assemble **one native D1 batch**, with no intermediate commits:

1. Create `resource_admission_counters_next` and `resource_admission_events_next` using the current
   baseline's two table declarations with only their declared table names changed. Keep the events'
   deferred grant reference pointing to the real `resource_admission_grants`.
2. Execute the following copy and guarded swap block. Existing grants stay in place; the grant
   cardinality trigger is removed only inside this fenced atomic conversion.
3. Install all current baseline indexes/triggers owned by the two final tables, plus
   `resource_admission_require_every_claim` and `resource_admission_review_session_owner`.
4. Execute the final grant/verification block. Publish matching code and align the single-baseline
   ledger only after the entire batch succeeds. Any failure, including one after source drops,
   rolls back DDL and data together. Baseline replay alone cannot upgrade an already applied schema.

<!-- pat-admission-copy:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'pat_admission_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM resource_admission_events WHERE policy_key='pat.review.session.v1')
 AND NOT EXISTS(SELECT 1 FROM resource_admission_counters WHERE policy_key='pat.pairing.source.v1')
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

INSERT INTO resource_admission_counters_next
 (rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id)
SELECT rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id
FROM resource_admission_counters;
INSERT INTO resource_admission_counters_next
 (policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used)
SELECT 'pat.pairing.source.v1',lower(hex(source_digest)),'anchored',window_start_ms,
 window_start_ms+600000,started_count FROM pat_pairing_admission;

INSERT INTO resource_admission_events_next
 (rowid,grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,
 window_start_epoch_ms,expires_at_epoch_ms,released_at_epoch_ms)
SELECT rowid,grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,
 window_start_epoch_ms,expires_at_epoch_ms,released_at_epoch_ms FROM resource_admission_events;
INSERT INTO resource_admission_events_next
 (grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,
 window_start_epoch_ms,expires_at_epoch_ms,owner_user_id,owner_session_id)
SELECT r.id,'pat.review.session.v1','source',r.session_id,'rolling_window',1,r.occurred_at_ms,
 max(0,r.occurred_at_ms-600000),r.occurred_at_ms+600000,s.user_id,r.session_id
FROM pat_review_attempts r JOIN web_sessions s ON s.id=r.session_id;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'pat_admission_cutover',CASE WHEN
 (SELECT count(*) FROM resource_admission_events_next)=
 (SELECT count(*) FROM resource_admission_events)+(SELECT count(*) FROM pat_review_attempts)
 AND (SELECT count(*) FROM resource_admission_counters_next)=
 (SELECT count(*) FROM resource_admission_counters)+(SELECT count(*) FROM pat_pairing_admission)
 AND NOT EXISTS(SELECT 1 FROM pat_review_attempts r
  LEFT JOIN resource_admission_events_next n ON n.grant_id=r.id AND n.policy_key='pat.review.session.v1'
  LEFT JOIN web_sessions s ON s.id=r.session_id
  WHERE n.grant_id IS NULL OR n.owner_session_id IS NOT r.session_id OR n.owner_user_id IS NOT s.user_id
   OR n.admitted_at_epoch_ms IS NOT r.occurred_at_ms OR n.expires_at_epoch_ms IS NOT r.occurred_at_ms+600000)
 AND NOT EXISTS(SELECT 1 FROM pat_pairing_admission r
  LEFT JOIN resource_admission_counters_next n ON n.policy_key='pat.pairing.source.v1' AND n.scope_key=lower(hex(r.source_digest))
  WHERE n.scope_key IS NULL OR n.used IS NOT r.started_count OR n.window_start_ms IS NOT r.window_start_ms
   OR n.window_ends_ms IS NOT r.window_start_ms+600000)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TRIGGER resource_admission_require_every_claim;
DROP TABLE pat_review_attempts;
DROP TABLE pat_pairing_admission;
DROP TABLE resource_admission_events;
DROP TABLE resource_admission_counters;
ALTER TABLE resource_admission_events_next RENAME TO resource_admission_events;
ALTER TABLE resource_admission_counters_next RENAME TO resource_admission_counters;
```

<!-- pat-admission-copy:end -->

<!-- pat-admission-grants:start -->

```sql
INSERT INTO resource_admission_grants(id,admitted_at_epoch_ms,claim_count)
SELECT grant_id,admitted_at_epoch_ms,1 FROM resource_admission_events WHERE policy_key='pat.review.session.v1';
INSERT INTO sql_assertions(scope,accepted)
SELECT 'pat_admission_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM resource_admission_events e
  WHERE e.policy_key='pat.review.session.v1' AND NOT EXISTS(
   SELECT 1 FROM web_sessions s WHERE s.id=e.owner_session_id AND s.user_id=e.owner_user_id))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='pat_admission_cutover';
```

<!-- pat-admission-grants:end -->

## Recovery admission gate (#1434)

**Do not drop or backfill `support_recovery_admissions`.** The shared one-event/one-grant candidate
failed #1434/#1405's native cost gate without simplifying the four rolling admission predicates.
Recovery retains its compact four-column store under the accepted design's explicit exception.
The conditional target mapping remains blocked; it is not a completed consolidation or a pending
quota-only deployment. No schema or migration ledger adjustment belongs to this slice.

[Native comparison evidence](recovery-admission-1434.md) includes admission, refusal, cleanup, exact
hour cutoffs and a fresh foreign operator. A future target revision must demonstrate equivalence
and a concrete cost/code benefit before any conversion or source-table removal. The current one-hour
accounting and original admission identities remain authoritative.

## Compaction admission (#1435)

Hosted execution supplies its same-User active session and live authority predicate to Resource
Admission's `hosted.compaction.user.v1` calendar transition. Three attempts per User per UTC day
remain charged even if subsequent model work fails or is abandoned. Different sessions share the
same day; midnight starts another retained window without resetting or removing older windows.
Resource Admission owns persistence and the `hosted_compaction_attempts` logical conversation-erasure
projection. Hosted execution still owns retention cadence and duration, via published discovery,
cleanup and deadline statements. Archives retain the original `{user_id,day_ms,used}` body.

For a populated database, complete #1433 first, back up D1 and fence all admission writers, Hosted
execution, retention and erasure. Assemble **one native D1 batch**:

1. Create `resource_admission_counters_next` from the final baseline table declaration, changing only
   its declared name. Do not install indexes/triggers before the copy and guarded swap below.
2. Execute `compaction-counter-copy`. Existing shared rowids remain exact. New compaction rowids use
   the original source rowid plus the maximum existing counter rowid (or zero); identity remains
   the original User and day. An overflow, policy collision, invalid count/day, orphan User or
   unrepresentable deadline aborts the whole batch. Never round inconsistent historical days.
3. Install every final baseline index/trigger owned by `resource_admission_counters`.
4. Execute `compaction-counter-verify`. Publish matching code and align the sole-baseline ledger
   only after success. Any failure after either source drop rolls back schema and data together.

Do not convert an unfinished erasure chunk, a restoring request, or live source rows belonging to an
unfinished erasure request. Finish that work under the old representation first. Historical archives
keep their exact request/store/reference/body and recovery-written marker; their opaque references
address archived snapshots, not new physical rowids. No archived-content restoration is introduced.
This prevents an in-progress archive generation from reselecting its original live rows under new
physical references. Existing source erasure triggers disappear with the source table; their logical
IDs and conversation safeguards are installed on the shared destination in the same batch.

<!-- compaction-counter-copy:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'compaction_counter_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM resource_admission_counters WHERE policy_key='hosted.compaction.user.v1')
 AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.restoring=1 OR
   (q.state<>'Complete' AND EXISTS(SELECT 1 FROM hosted_compaction_attempts r WHERE r.user_id=q.user_id)))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

INSERT INTO resource_admission_counters_next
 (rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id)
SELECT rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id
FROM resource_admission_counters;
INSERT INTO resource_admission_counters_next
 (rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,owner_user_id)
SELECT r.rowid+(SELECT coalesce(max(rowid),0) FROM resource_admission_counters),
 'hosted.compaction.user.v1',r.user_id,'calendar',r.day_ms,r.day_ms+86400000,r.used,r.user_id
FROM hosted_compaction_attempts r;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'compaction_counter_cutover',CASE WHEN
 (SELECT count(*) FROM resource_admission_counters_next)=
 (SELECT count(*) FROM resource_admission_counters)+(SELECT count(*) FROM hosted_compaction_attempts)
 AND NOT EXISTS(SELECT 1 FROM hosted_compaction_attempts r
  LEFT JOIN resource_admission_counters_next n ON n.policy_key='hosted.compaction.user.v1'
   AND n.scope_key=r.user_id AND n.window_start_ms=r.day_ms
  WHERE n.scope_key IS NULL OR n.owner_user_id IS NOT r.user_id OR n.used IS NOT r.used
   OR n.window_ends_ms IS NOT r.day_ms+86400000)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE hosted_compaction_attempts;
DROP TABLE resource_admission_counters;
ALTER TABLE resource_admission_counters_next RENAME TO resource_admission_counters;
```

<!-- compaction-counter-copy:end -->

<!-- compaction-counter-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'compaction_counter_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='compaction_counter_cutover';
```

<!-- compaction-counter-verify:end -->

The sole baseline is the fresh-database shape, not an upgrade script for an already-applied schema.
This conversion and its matching Worker publication remain local and undeployed until remote quota
permits the fenced cutover. Recovery #1434's failed conversion remains excluded.

## Audit retention permits (#1436)

Ordinary Audit retention now installs a two-field `audit_retention_permits` row instead of mutating
User. Its exact User and cutoff authorize only `session_call`, `credential_call`, `insight_call` and
`publication` records strictly older than the existing 365-day boundary. Each bounded unit inserts
one permit, asserts successful acquisition, deletes up to 64 eligible records, and deletes the permit
in the same native D1 batch. Any failure rolls back both permission and deletions. An unexpected
retained permit causes acquisition to fail; ordinary retention never overwrites or adopts its cutoff.
Investigate that anomaly under fenced maintenance rather than treating it as standing permission.

Independent request-admission cleanup remains 93 days and Recovery remains 24 calendar months after
terminal closure. This slice moves no other Audit variants or owner evidence. Ordinary permission
cannot bypass an erasure fence; exact purpose-specific erasure permissions and the logical
`audit_retention_permits` projection remain independently enforced. Archived permit snapshots retain
their original request/store/reference/body; snapshots are historical evidence, never live authority.

For an existing development database, back up D1 and fence Audit retention and erasure through the
code/schema cutover. **Refuse any non-null old cutoff**, including zero: a completed old transaction
must already have cleared it. Investigate the original anomaly rather than copying it into a live
permit or silently clearing it. Drain any unfinished erasure chunk with the old code first.

Assemble one native D1 batch with no intermediate commits:

1. Create `audit_retention_permits` using the final baseline declaration. A pre-existing destination
   is an unexplained collision and must fail, not be reused.
2. Execute `audit-retention-permit-cutover` below. Only the obsolete User column is dropped; User
   rowids, every retained User field, Audit sequences/identities/timestamps and related records remain
   unchanged. No Audit history or archive is copied, relabeled or reconstructed.
3. Install the final baseline `audit_entries_no_delete` trigger and all indexes/triggers owned by
   `audit_retention_permits`. The old field-clear preservation trigger has no role on the new table;
   its delete preservation trigger handles removal directly.
4. Execute `audit-retention-permit-verify`. Publish matching code and align the single-baseline ledger
   only after success. A failure after column removal rolls back DDL and data together. The edited
   baseline alone does not convert an already applied database.

<!-- audit-retention-permit-cutover:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'audit_retention_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM users WHERE audit_retention_cutoff_ms IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DROP TRIGGER audit_entries_no_delete;
DROP TRIGGER erasure_fence_audit_retention_permits_insert;
DROP TRIGGER erasure_fence_audit_retention_permits_update;
DROP TRIGGER erasure_fence_audit_retention_permits_delete;
DROP TRIGGER erasure_preserve_audit_retention_permits_delete;
DROP TRIGGER erasure_preserve_audit_retention_permits_delete_clear;
ALTER TABLE users DROP COLUMN audit_retention_cutoff_ms;
```

<!-- audit-retention-permit-cutover:end -->

<!-- audit-retention-permit-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'audit_retention_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM audit_retention_permits)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='audit_retention_cutover';
```

<!-- audit-retention-permit-verify:end -->

The global and User-specific partial ordinary-retention indexes remain in place. Audit owns this
permission table and its existing erasure dependency; no User-profile write is needed for routine
cleanup. Changes remain local and undeployed until quota allows the fenced cutover.

## Existing-User Consent offers (#1437)

Weekly and proactive Consent share `consent_offers`: the accepted 15 stored fields and the two
existing generated typed offer identifiers. Generation, delivery, decisions and erasure query that
store directly. The two logical erasure projections keep their original field sets and archive
identities; proactive disclosures still have no recorded disclosure timestamp. No table, column,
recipient, disclosure, source identity or instant is copied or reconstructed in this slice.

Weekly short offers and proactive offers retain their ten-minute lifetime; weekly Governor-question
offers retain their 24-hour lifetime. Existing daily admission rules remain unchanged. Weekly source
replay returns the same still-live source offer and acceptance compares the captured rejection with
the latest rejection in its authoritative write. A replaced proactive offer cannot acquire delivery
evidence or be accepted after replacement, including a disclosure prepared before replacement.

New insertion guards require replacement references to identify the same User and category, rejection
references to identify that User's `weekly_rejection`, and Consent history to reference that User's
matching offer category. These capture guards deliberately do not create a permanent self-FK: ordinary
bounded cleanup may delete an expired, undecided replacement ancestor while its newer child remains.
Existing offer identity/reference immutability prevents subsequent relinking. The extra validation
also refuses invalid disclosure JSON, nonpositive offer lifetimes and decisions without disclosure.

For an existing development database, back up D1, fence Consent/Insights writers and erasure, and drain
in-flight work with the old code. Submit this sequence as **one native D1 batch**, without intermediate
commits:

1. Execute `consent-offers-preflight` below. Any mismatch blocks the cutover. A missing replacement
   ancestor might be explained by prior expiry cleanup, but its original ownership/category cannot
   be inferred from absence. Investigate from retained evidence before proceeding; never manufacture
   a parent, clear a reference or rewrite accepted history to pass the check.
2. Install the exact final-baseline declarations of `consent_offer_valid_insert`,
   `consent_offer_valid_update` and `consent_history_offer_owner`. Do not use `IF NOT EXISTS` to adopt
   unexpected destination objects. Keep all existing typed identifiers, keys, indexes, immutable
   evidence and erasure guards in place.
3. Execute `consent-offers-verify`. Only after success publish matching code and align the
   single-baseline ledger. A failure after any trigger creation rolls back the complete batch.

<!-- consent-offers-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_offers_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM consent_offers o WHERE
   NOT json_valid(o.disclosure_json) OR o.expires_at_ms<=o.created_at_ms
   OR (o.decision IS NOT NULL AND o.disclosure_message_id IS NULL)
   OR (o.rejection_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM consent_history r WHERE r.user_id=o.user_id
     AND r.record_type='weekly_rejection' AND r.id=o.rejection_id))
   OR (o.replaces_offer_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM consent_offers old WHERE old.user_id=o.user_id AND old.kind=o.kind
     AND old.id=o.replaces_offer_id AND old.id<>o.id)))
 AND NOT EXISTS(SELECT 1 FROM consent_history h WHERE
   (h.weekly_offer_reference IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM consent_offers o WHERE o.user_id=h.user_id
     AND o.kind='weekly-summary' AND o.id=h.weekly_offer_reference))
   OR (h.proactivity_offer_reference IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM consent_offers o WHERE o.user_id=h.user_id
     AND o.kind=h.kind AND o.id=h.proactivity_offer_reference)))
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- consent-offers-preflight:end -->

<!-- consent-offers-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_offers_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='consent_offers_cutover';
```

<!-- consent-offers-verify:end -->

The populated native cutover test executes these blocks and the baseline trigger definitions,
compares exact rows (including rowids, missing timestamps, source/rejection/replacement identities
and archives), and exercises rollback after trigger installation and refusal of inconsistent history.
These changes are local and undeployed while D1 quota is exhausted. Editing the applied baseline alone
does not install the new guards on an existing database. Consent history extraction and pre-User
exchanges remain separate tickets.

## Durable Consent history (#1438)

`consent_history` retains 23 stored fields plus its existing generated typed-reference helpers.
Grant/renewal event times use `occurred_at_ms`; `decision_received_at_ms` remains independent.
PAT/OAuth disclosure JSON is exactly `{"revision": original revision, "text": original text}`.
The text stays a string even when it contains JSON: parsing and reserializing it would alter original
bytes. Full processing disclosure snapshots and serialized notification ConsentRecords remain exact.
The latter retain independently meaningful disclosure and provider-qualified evidence; this slice
does not remove their embedded envelope fields without historical equivalence proof.

Automatic PAT expiry uses `reason`; browser-origin revocations retain their session and no automatic
reason. Existing record-kind constraints, append-only rules, same-User links, offer category checks,
scoped uniqueness, null IDs, erasure dependencies and policy remain in force. Erasure projections and
drain triggers keep the original archive field names and values. Already written archives are never
rewritten or reinterpreted as live Consent.

### Fenced populated cutover

Back up D1 and fence **all** application writers, including onboarding, PAT/OAuth decisions, Insights,
forwarded mail and erasure. The edited single baseline is for fresh installation; it does not update
an existing database. This is one coordinated code/schema cutover, with no mixed-client release.

Capture the current trigger/view definitions that directly reference `consent_history` from
`sqlite_schema` (`sql IS NOT NULL`, word-qualified table reference), including triggers owned by other
tables. Record their exact names/types and map each to its final baseline definition. Stop if any
source object has no explained destination or a destination is already present unexpectedly. Also
capture every explicit index owned by Consent history. The baseline still owns the same helpers and
incoming references. Do not turn foreign keys off or use `legacy_alter_table` to hide stale objects.

Assemble **one native D1 batch** in this order; no intermediate commits:

1. `PRAGMA defer_foreign_keys=ON`, then `consent-history-preflight` below. Refuse conflicting or
   unmappable timestamp, disclosure and reason variants; inspect original evidence instead of
   selecting one value or fabricating missing facts. Drain any active erasure chunk first.
2. Drop the captured dependent triggers/views by exact validated identifiers. Create
   `consent_history_next` from the final baseline `consent_history` declaration, changing only the
   CREATE table name. Its self-references continue to name `consent_history`.
3. Execute `consent-history-copy`. Original sequences and the AUTOINCREMENT high-water mark survive,
   including a removed highest row. No forwarding address, credential or other domain side effect
   runs while copying; owner triggers are installed after copying.
4. Execute `consent-history-swap`, then install the final baseline indexes and the captured dependent
   triggers/views at their final destinations. Ordinary permissions cannot authorize this operation.
5. Execute `consent-history-verify`. Only after success publish matching code and align the one-file
   baseline ledger. Any failure, including one after DROP/rename, rolls back data and DDL together.

<!-- consent-history-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_history_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM consent_history WHERE
   (record_type IN ('processing_grant','processing_renewal','pat_grant','oauth_grant') AND (accepted_at_ms IS NULL OR occurred_at_ms IS NOT NULL))
   OR (record_type NOT IN ('processing_grant','processing_renewal','pat_grant','oauth_grant') AND accepted_at_ms IS NOT NULL)
   OR (record_type IN ('pat_grant','pat_revocation','oauth_grant','oauth_user_revocation') AND (disclosure_revision IS NULL OR disclosure_text IS NULL OR disclosure_json IS NOT NULL))
   OR (record_type NOT IN ('pat_grant','pat_revocation','oauth_grant','oauth_user_revocation') AND (disclosure_revision IS NOT NULL OR disclosure_text IS NOT NULL))
   OR (record_type='pat_revocation' AND reason IS NOT NULL)
   OR (record_type<>'pat_revocation' AND policy_reason IS NOT NULL))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- consent-history-preflight:end -->

<!-- consent-history-copy:start -->

```sql
INSERT INTO consent_history_next (sequence, record_type, id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, grant_record_id, session_id, occurred_at_ms, withdrawal_id, grant_id, offer_id, record_json, decision, kind, pairing_id, request_id, grant_consent_id, pat_id, connection_id, reason)
SELECT sequence,
 record_type,
 id,
 user_id,
 CASE WHEN record_type IN ('pat_grant','pat_revocation','oauth_grant','oauth_user_revocation') THEN json_object('revision',disclosure_revision,'text',disclosure_text) ELSE disclosure_json END,
 disclosure_message_id,
 decision_message_id,
 decision_received_at_ms,
 grant_record_id,
 session_id,
 CASE WHEN record_type IN ('processing_grant','processing_renewal','pat_grant','oauth_grant') THEN accepted_at_ms ELSE occurred_at_ms END,
 withdrawal_id,
 grant_id,
 offer_id,
 record_json,
 decision,
 kind,
 pairing_id,
 request_id,
 grant_consent_id,
 pat_id,
 connection_id,
 CASE WHEN record_type='pat_revocation' THEN policy_reason ELSE reason END
FROM consent_history ORDER BY sequence;
UPDATE sqlite_sequence SET seq=(SELECT seq FROM sqlite_sequence WHERE name='consent_history')
WHERE name='consent_history_next' AND EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='consent_history');
INSERT INTO sqlite_sequence(name,seq)
SELECT 'consent_history_next',seq FROM sqlite_sequence WHERE name='consent_history'
 AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='consent_history_next');
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_history_cutover',CASE WHEN
 (SELECT count(*) FROM consent_history)=(SELECT count(*) FROM consent_history_next)
 AND NOT EXISTS(SELECT * FROM (
 SELECT sequence,
 record_type,
 id,
 user_id,
 CASE WHEN record_type IN ('pat_grant','pat_revocation','oauth_grant','oauth_user_revocation') THEN json_object('revision',disclosure_revision,'text',disclosure_text) ELSE disclosure_json END,
 disclosure_message_id,
 decision_message_id,
 decision_received_at_ms,
 grant_record_id,
 session_id,
 CASE WHEN record_type IN ('processing_grant','processing_renewal','pat_grant','oauth_grant') THEN accepted_at_ms ELSE occurred_at_ms END,
 withdrawal_id,
 grant_id,
 offer_id,
 record_json,
 decision,
 kind,
 pairing_id,
 request_id,
 grant_consent_id,
 pat_id,
 connection_id,
 CASE WHEN record_type='pat_revocation' THEN policy_reason ELSE reason END
 FROM consent_history EXCEPT SELECT sequence, record_type, id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, grant_record_id, session_id, occurred_at_ms, withdrawal_id, grant_id, offer_id, record_json, decision, kind, pairing_id, request_id, grant_consent_id, pat_id, connection_id, reason FROM consent_history_next))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- consent-history-copy:end -->

<!-- consent-history-swap:start -->

```sql
DROP TABLE consent_history;
ALTER TABLE consent_history_next RENAME TO consent_history;
```

<!-- consent-history-swap:end -->

<!-- consent-history-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_history_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
PRAGMA defer_foreign_keys=OFF;
DELETE FROM sql_assertions WHERE scope='consent_history_cutover';
```

<!-- consent-history-verify:end -->

After the explicit whole-database foreign-key assertion succeeds, the batch resumes immediate
checking with `PRAGMA defer_foreign_keys=OFF`, as supported by
[Cloudflare's foreign-key guidance](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).
The explicit check is required: in native D1 a populated drop/rename can leave deferred bookkeeping
that still rejects commit despite valid final references. Do not omit the assertion, leave real
violations unresolved, or append unguarded mutations after verification. The native test also proves
that an injected orphan before verification blocks commit and that immediate checking resumes afterward.

The populated native test runs these exact blocks with baseline DDL. It verifies original disclosures,
missing timestamps, parent links, anonymous-ID OAuth revocations, sequence high-water, unrelated User
and offer rows, archives, constraint rejection, and interruption after the destructive swap. Historical
source DDL lives only in a test fixture; it is not another migration or a runtime compatibility path.
Changes stay local until quota permits a separately authorized deployment.

## Pre-User Consent exchanges (#1439)

`pending_consent_exchanges` keeps 27 stored fields. The five decision recipient/disclosure snapshots
are represented by the exchange's immutable portfolio, recipient, business number, exact disclosure
and established disclosure-message identity. An absent decision still has absent decision evidence;
erasure projections and drain archives reconstruct the original five keys as NULL in that case.
Already written archives keep their exact original representation.

The atomic decision write compares authenticated inbound recipient/business-number evidence and the
read disclosure against that immutable basis. A zero-row write aborts the same batch as the admission
release. Replay identities, exact occurrence/receipt times, 24-hour expiry, callback-versus-applied
state, sandbox handling, and atomic provider-verified signup remain unchanged. No workflow per
exchange or initial financial-message content is introduced.

### Fenced populated cutover

Back up D1 and fence WhatsApp callbacks, disclosure send/recovery, provider onboarding, maintenance
and erasure writers. The single edited baseline installs fresh databases; an existing database needs
this coordinated schema/code cutover. Drain active erasure chunks. Capture every trigger/view that
directly references `pending_consent_exchanges`, including objects owned by other tables, plus every trigger/view referencing the two cascading
children `whatsapp_provider_handoffs` and `provider_authentication_attempts`, and all explicit indexes
on the exchange table. Inspect the live FK graph: these must be the only cascading descendants; stop
on an unexplained additional descendant. Match each source object to its final baseline destination; stop on unknown
objects or an unexpected pre-existing destination. Keep handoff rows and their incoming references.

Submit one native D1 batch, without intermediate commits:

1. `PRAGMA defer_foreign_keys=ON`, then `consent-exchanges-preflight`. Exact binary text equality
   and original NULL missingness must hold for all five snapshots. A mismatch blocks conversion;
   inspect the evidence and review its representation before proceeding, never overwrite it.
2. Drop the captured dependent triggers/views. Create `pending_consent_exchanges_next` using the
   final baseline declaration with only the CREATE name changed. Copy with `consent-exchanges-copy`.
   Preserve rowids as well as explicit exchange/replay identities and exact original bytes/instants.
   Stage both cascading child sets in the same batch before DROP. FK deferral does not suppress
   ON DELETE CASCADE; all dependent guards and side-effect triggers must be absent during the swap.
3. Run `consent-exchanges-swap`, restoring the original child rowids/columns in parent-first order
   and checking their exact values before removing staging. Then reinstall final baseline indexes
   and mapped triggers/views. Unrelated provider attempts with no handoff remain untouched.
4. Run `consent-exchanges-verify`: whole-database FK verification precedes resuming immediate
   checking. Only then publish matching code and align the one-file baseline ledger.

Failure at any stage rolls back the whole native batch, including the destructive swap. Retained
archives, User/Consent history, provider handoffs and other owner records are not rewritten.

<!-- consent-exchanges-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_exchanges_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM pending_consent_exchanges WHERE
   (decision_value IS NULL AND (decision_portfolio_id IS NOT NULL OR decision_bsuid IS NOT NULL OR decision_phone_number_id IS NOT NULL OR decision_disclosure_json IS NOT NULL OR decision_disclosure_message_id IS NOT NULL))
   OR (decision_value IS NOT NULL AND (decision_portfolio_id IS NOT portfolio_id OR decision_bsuid IS NOT bsuid OR decision_phone_number_id IS NOT phone_number_id OR decision_disclosure_json IS NOT disclosure_json OR decision_disclosure_message_id IS NOT disclosure_message_id)))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- consent-exchanges-preflight:end -->

<!-- consent-exchanges-copy:start -->

```sql
CREATE TABLE whatsapp_provider_handoffs_consent_cutover AS SELECT rowid AS source_rowid, * FROM whatsapp_provider_handoffs WHERE 1;
CREATE TABLE provider_authentication_attempts_consent_cutover AS SELECT rowid AS source_rowid, * FROM provider_authentication_attempts WHERE handoff_id IS NOT NULL;
INSERT INTO pending_consent_exchanges_next (rowid, id, portfolio_id, bsuid, phone_number_id, initiating_message_id, initiating_body_sha256, correlation_token, disclosure_json, disclosure_message_id, created_at_ms, disclosed_at_ms, decision_not_before_ms, expires_at_ms, state, rejected_at_ms, sandbox_phone, delivery_phone_number_id, delivery_message_id, delivery_occurred_at_ms, delivery_received_at_ms, delivery_not_before_ms, decision_value, decision_message_id, decision_delivery_key, decision_body_sha256, decision_occurred_at_ms, decision_received_at_ms)
SELECT rowid, id, portfolio_id, bsuid, phone_number_id, initiating_message_id, initiating_body_sha256, correlation_token, disclosure_json, disclosure_message_id, created_at_ms, disclosed_at_ms, decision_not_before_ms, expires_at_ms, state, rejected_at_ms, sandbox_phone, delivery_phone_number_id, delivery_message_id, delivery_occurred_at_ms, delivery_received_at_ms, delivery_not_before_ms, decision_value, decision_message_id, decision_delivery_key, decision_body_sha256, decision_occurred_at_ms, decision_received_at_ms FROM pending_consent_exchanges ORDER BY rowid;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_exchanges_cutover',CASE WHEN
 (SELECT count(*) FROM pending_consent_exchanges)=(SELECT count(*) FROM pending_consent_exchanges_next)
 AND NOT EXISTS(SELECT rowid, id, portfolio_id, bsuid, phone_number_id, initiating_message_id, initiating_body_sha256, correlation_token, disclosure_json, disclosure_message_id, created_at_ms, disclosed_at_ms, decision_not_before_ms, expires_at_ms, state, rejected_at_ms, sandbox_phone, delivery_phone_number_id, delivery_message_id, delivery_occurred_at_ms, delivery_received_at_ms, delivery_not_before_ms, decision_value, decision_message_id, decision_delivery_key, decision_body_sha256, decision_occurred_at_ms, decision_received_at_ms FROM pending_consent_exchanges
   EXCEPT SELECT rowid, id, portfolio_id, bsuid, phone_number_id, initiating_message_id, initiating_body_sha256, correlation_token, disclosure_json, disclosure_message_id, created_at_ms, disclosed_at_ms, decision_not_before_ms, expires_at_ms, state, rejected_at_ms, sandbox_phone, delivery_phone_number_id, delivery_message_id, delivery_occurred_at_ms, delivery_received_at_ms, delivery_not_before_ms, decision_value, decision_message_id, decision_delivery_key, decision_body_sha256, decision_occurred_at_ms, decision_received_at_ms FROM pending_consent_exchanges_next)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- consent-exchanges-copy:end -->

<!-- consent-exchanges-swap:start -->

```sql
DROP TABLE pending_consent_exchanges;
ALTER TABLE pending_consent_exchanges_next RENAME TO pending_consent_exchanges;
INSERT INTO whatsapp_provider_handoffs (rowid, id, exchange_id, created_at_ms, expires_at_ms, handoff_send_started_ms, pairing_id, review_code, review_started_ms, review_message_id, decision, decision_message_id, confirmed_at_ms, consumed_at_ms) SELECT source_rowid, id, exchange_id, created_at_ms, expires_at_ms, handoff_send_started_ms, pairing_id, review_code, review_started_ms, review_message_id, decision, decision_message_id, confirmed_at_ms, consumed_at_ms FROM whatsapp_provider_handoffs_consent_cutover;
INSERT INTO sql_assertions(scope,accepted) SELECT 'consent_exchanges_cutover',CASE WHEN
 NOT EXISTS(SELECT source_rowid, id, exchange_id, created_at_ms, expires_at_ms, handoff_send_started_ms, pairing_id, review_code, review_started_ms, review_message_id, decision, decision_message_id, confirmed_at_ms, consumed_at_ms FROM whatsapp_provider_handoffs_consent_cutover
 EXCEPT SELECT rowid, id, exchange_id, created_at_ms, expires_at_ms, handoff_send_started_ms, pairing_id, review_code, review_started_ms, review_message_id, decision, decision_message_id, confirmed_at_ms, consumed_at_ms FROM whatsapp_provider_handoffs) THEN 1 ELSE 0 END
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DROP TABLE whatsapp_provider_handoffs_consent_cutover;
INSERT INTO provider_authentication_attempts (rowid, id, pairing_id, cookie_digest, nonce, intent, disclosure_json, consent_at_ms, created_at_ms, expires_at_ms, state, issuer, subject, contact_email, user_id, provider, handoff_id, completed_at_ms, created_user) SELECT source_rowid, id, pairing_id, cookie_digest, nonce, intent, disclosure_json, consent_at_ms, created_at_ms, expires_at_ms, state, issuer, subject, contact_email, user_id, provider, handoff_id, completed_at_ms, created_user FROM provider_authentication_attempts_consent_cutover;
INSERT INTO sql_assertions(scope,accepted) SELECT 'consent_exchanges_cutover',CASE WHEN
 NOT EXISTS(SELECT source_rowid, id, pairing_id, cookie_digest, nonce, intent, disclosure_json, consent_at_ms, created_at_ms, expires_at_ms, state, issuer, subject, contact_email, user_id, provider, handoff_id, completed_at_ms, created_user FROM provider_authentication_attempts_consent_cutover
 EXCEPT SELECT rowid, id, pairing_id, cookie_digest, nonce, intent, disclosure_json, consent_at_ms, created_at_ms, expires_at_ms, state, issuer, subject, contact_email, user_id, provider, handoff_id, completed_at_ms, created_user FROM provider_authentication_attempts) THEN 1 ELSE 0 END
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DROP TABLE provider_authentication_attempts_consent_cutover;
```

<!-- consent-exchanges-swap:end -->

<!-- consent-exchanges-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_exchanges_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
PRAGMA defer_foreign_keys=OFF;
DELETE FROM sql_assertions WHERE scope='consent_exchanges_cutover';
```

<!-- consent-exchanges-verify:end -->

## Verified email credential (#1440)

Email Authentication owns `verified_email_credentials(user_id,address,verified_at_ms)`. One User
has at most one normalized, case-insensitively unique login email; provider/billing contact email
is not that credential. Original address bytes and verification milliseconds are preserved. A pending
replacement retains its fourteen fields, the original credential stays valid until successful proof,
and both sending and completion recheck the exact prior address/time and fresh session. Pairing's
credential snapshot, proof generations, ambiguous-send behavior and admission windows are unchanged.
No raw proof or new wait-for-user Workflow is introduced.

Credential erasure deletes this row independently of the User. Preserve original credential rowrefs
by copying each source User rowid. Existing credential archives contain only `{}` and keep their
original identity; they do not restore a usable credential. Other User archives remain untouched.
An in-progress `erasure_chunk` blocks cutover rather than reinterpreting its active selection.

### Fenced populated cutover

Back up D1 and fence all email pairing/replacement request, dispatch, Workflow and verification
writers, onboarding and erasure. Capture all triggers/views referring to `verified_email_address` or
`email_verified_at_ms` from `sqlite_schema`, plus the `users_verified_email` index. The expected three
field-fence triggers move to the credential table; map every captured object to its final baseline
destination and stop on unknown objects or a pre-existing target table. No mixed-code/schema release.

Execute one native D1 batch:

1. `email-credential-preflight` rejects partial credentials, non-normalized addresses, duplicate
   case-insensitive addresses, active erasure chunks and foreign-key violations. Investigate original
   evidence instead of changing an address or manufacturing a verification time.
2. Create `verified_email_credentials` from the final baseline declaration, without its triggers.
   Run `email-credential-copy`, preserving source rowids and comparing all original credential values.
3. Drop the captured source triggers/views, then run `email-credential-remove-source`. Drop the
   timestamp column before the address column because its source CHECK refers to the address.
   This uses ALTER TABLE DROP COLUMN: User rows, rowids, indexes and incoming references stay in place,
   without DROP/rename or cascading deletion. Do not disable foreign keys.
4. Install the mapped final baseline triggers/views, then run `email-credential-verify`. Publish the
   matching code and align the single baseline ledger only after successful verification.

Any failure rolls back the copy and both column removals atomically. The changed baseline alone does
not migrate an existing database. No runtime fallback reads the old User fields.

<!-- email-credential-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email_credential_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM users WHERE
   (verified_email_address IS NULL)<>(email_verified_at_ms IS NULL)
   OR (verified_email_address IS NOT NULL AND verified_email_address COLLATE BINARY<>lower(trim(verified_email_address))))
 AND (SELECT count(verified_email_address) FROM users)=
     (SELECT count(DISTINCT verified_email_address COLLATE NOCASE) FROM users)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- email-credential-preflight:end -->

<!-- email-credential-copy:start -->

```sql
INSERT INTO verified_email_credentials(rowid,user_id,address,verified_at_ms)
SELECT rowid,id,verified_email_address,email_verified_at_ms FROM users WHERE verified_email_address IS NOT NULL;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email_credential_cutover',CASE WHEN
 (SELECT count(*) FROM verified_email_credentials)=(SELECT count(*) FROM users WHERE verified_email_address IS NOT NULL)
 AND NOT EXISTS(SELECT rowid,id,verified_email_address,email_verified_at_ms FROM users WHERE verified_email_address IS NOT NULL
 EXCEPT SELECT rowid,user_id,address,verified_at_ms FROM verified_email_credentials)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- email-credential-copy:end -->

<!-- email-credential-remove-source:start -->

```sql
DROP INDEX users_verified_email;
ALTER TABLE users DROP COLUMN email_verified_at_ms;
ALTER TABLE users DROP COLUMN verified_email_address;
```

<!-- email-credential-remove-source:end -->

<!-- email-credential-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email_credential_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='email_credential_cutover';
```

<!-- email-credential-verify:end -->

## One-use recovery credential (#1441)

This synchronized cutover replaces the four embedded User recovery fields with the five-field
`backup_recovery_credentials` record. It preserves the current digest bytes, original creation and
consumption instants, revision, User identity and source rowid. The rowid remains the credential's
existing erasure archive address; existing `{}` archives remain unchanged and contain no code or digest.
No raw code can be recovered or disclosed by this conversion. Support-case history and the existing
rolling operator admission policy are unchanged.

Back up D1 and fence provider/onboarding completion, credential issuance/rotation, support recovery
and erasure. Capture every trigger/view referring to `recovery_code_digest`, `recovery_created_at_ms`,
`recovery_consumed_at_ms` or `recovery_revision`, and the `users_recovery_digest` index. Expected
objects are the three credential fences and `provider_completion_requires_proof`; map them to the
final baseline and stop on unknown dependencies or a pre-existing destination. Apply #1440 first
where both cutovers are pending. Do not publish mixed schema/code.

Execute one native D1 batch:

1. Run `recovery-credential-preflight`. Reject partial groups, invalid digest bytes, duplicate
   digests, active erasure chunks and foreign-key violations. Investigate inconsistent evidence;
   never invent issuance instants or revisions, discard credentials or change original digests.
2. Create the credential table from the final baseline, without its fences. Run
   `recovery-credential-copy` and compare every original credential value and rowid.
3. Drop captured dependent triggers/views. Run `recovery-credential-remove-source`: remove the
   revision column first because its source CHECK references the other credential fields. User
   rows, rowids, other indexes and incoming references stay intact; do not drop/rename User or disable
   foreign keys.
4. Install mapped final baseline dependencies, then run `recovery-credential-verify`. Only after
   success publish matching code and align the single baseline ledger.

Any failure rolls back both the credential copy and source removal. The editable clean-install
baseline alone does not convert an existing database. There is no runtime fallback to embedded fields.

<!-- recovery-credential-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_credential_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM users WHERE
   (recovery_code_digest IS NULL AND (recovery_created_at_ms IS NOT NULL OR recovery_consumed_at_ms IS NOT NULL OR recovery_revision IS NOT NULL))
   OR (recovery_code_digest IS NOT NULL AND (typeof(recovery_code_digest)<>'blob' OR length(recovery_code_digest)<>32 OR recovery_created_at_ms IS NULL OR recovery_revision IS NULL)))
 AND (SELECT count(recovery_code_digest) FROM users)=(SELECT count(DISTINCT recovery_code_digest) FROM users)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- recovery-credential-preflight:end -->

<!-- recovery-credential-copy:start -->

```sql
INSERT INTO backup_recovery_credentials(rowid,user_id,code_digest,created_at_ms,consumed_at_ms,revision)
SELECT rowid,id,recovery_code_digest,recovery_created_at_ms,recovery_consumed_at_ms,recovery_revision
FROM users WHERE recovery_code_digest IS NOT NULL;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_credential_cutover',CASE WHEN
 (SELECT count(*) FROM backup_recovery_credentials)=(SELECT count(*) FROM users WHERE recovery_code_digest IS NOT NULL)
 AND NOT EXISTS(SELECT rowid,id,recovery_code_digest,recovery_created_at_ms,recovery_consumed_at_ms,recovery_revision FROM users WHERE recovery_code_digest IS NOT NULL
 EXCEPT SELECT rowid,user_id,code_digest,created_at_ms,consumed_at_ms,revision FROM backup_recovery_credentials)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- recovery-credential-copy:end -->

<!-- recovery-credential-remove-source:start -->

```sql
DROP INDEX users_recovery_digest;
ALTER TABLE users DROP COLUMN recovery_revision;
ALTER TABLE users DROP COLUMN recovery_consumed_at_ms;
ALTER TABLE users DROP COLUMN recovery_created_at_ms;
ALTER TABLE users DROP COLUMN recovery_code_digest;
```

<!-- recovery-credential-remove-source:end -->

<!-- recovery-credential-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_credential_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='recovery_credential_cutover';
```

<!-- recovery-credential-verify:end -->

## Recovery case evidence (#1442)

The ten logical fields of `support_recovery_cases` own the immutable operator and terminal decision.
New approvals no longer create duplicate `support_recovery` Audit rows. Four nullable metadata fields
retain migrated opening/decision event IDs and their original Audit sequence-based archive addresses;
they do not repeat actor, action or time. New cases leave this historical metadata absent. The original
`support_recovery_events` erasure purpose clears only this migrated identity metadata before case deletion.
Existing `{}` archives retain their exact store IDs, generation-qualified row references and bodies.
Ordinary retention remains 24 calendar months after closure, including the referenced browser pairing.
Recovery never supplies the independent browser-private verifier.

Apply #1441 first. Back up and fence all recovery approval/rotation, Audit writers/retention, browser
pairing cleanup and erasure. Capture the original Audit table, its sequence watermark, every dependent
index/trigger/view and all Case dependencies. Map each to the final baseline; stop on unknown objects
or incoming Audit foreign keys. No temporary table may already exist. The batch below rebuilds only
Audit, which currently has no incoming foreign keys; it never rebuilds User, Case or Pairing.

Execute one native D1 batch:

1. Run `recovery-evidence-preflight`. Require exactly one opening and one matching terminal event
   per case. Reject orphan, missing, repeated, differently attributed or timed events, a decision
   inconsistent with case state, foreign ownership, foreign-key violations or active erasure.
   Matching rejected decisions are preserved as rejected cases; exceptional history blocks conversion
   for investigation rather than being discarded or rewritten.
2. Drop captured Audit triggers/views before rebuilding. Create `audit_entries_1442` using the final
   pre-#1446 Audit declaration (retained in `oauth-agents/lineage-before-1446.fixture.sql`)
   with only its table name changed. Apply #1446 after this extraction. Run `recovery-evidence-copy`: preserve
   all unrelated writable Audit fields and sequences, its AUTOINCREMENT high-water mark and every
   case field/rowid. Keep generated columns derived by the unchanged final expressions.
3. Run `recovery-evidence-replace`, then reinstall mapped final baseline Audit dependencies and the
   final Case indexes/guards. The existing Case indexes and erasure insert/delete fences stay;
   replace its update fence with the final field-specific one. Metadata may only be cleared under
   its original same-User erasure permit; ordinary updates cannot change case evidence.
4. Run `recovery-evidence-verify`. Publish matching code and align the one-baseline ledger only after
   the batch succeeds. The baseline alone does not convert an existing database.

Every failure rolls back both event extraction and Audit replacement. Do not disable foreign keys,
reassign IDs, reset sequence ordering, infer an operator from current data or invent absent events.
The native cutover fixture executes these exact blocks and final baseline definitions.

For every captured application table, render `__TABLE_NAME__` below as its exact trusted schema
name (including application tables outside the baseline, excluding SQLite internals and Cloudflare's
platform-owned `_cf_METADATA`) and append the assertion to the same preflight batch.
D1 requires a literal table name for this pragma; a dynamic pragma join is refused by its authorizer.
Any incoming Audit foreign key must stop the rebuild and be designed explicitly.

<!-- recovery-evidence-references:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_evidence_cutover',CASE WHEN NOT EXISTS(
 SELECT 1 FROM pragma_foreign_key_list('__TABLE_NAME__') WHERE "table"='audit_entries')
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- recovery-evidence-references:end -->

<!-- recovery-evidence-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_evidence_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM support_recovery_cases c WHERE
   NOT EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=c.pairing_id AND p.user_id=c.user_id)
   OR (SELECT count(*) FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id)<>2
   OR (SELECT count(*) FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action='opened')<>1
   OR (SELECT count(*) FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action=c.state)<>1)
 AND NOT EXISTS(SELECT 1 FROM audit_entries e LEFT JOIN support_recovery_cases c ON c.id=e.recovery_case_id
   WHERE e.record_type='support_recovery' AND (c.id IS NULL OR e.user_id IS NOT c.user_id
   OR e.operator_issuer IS NOT c.operator_issuer OR e.operator_subject IS NOT c.operator_subject
   OR (e.recovery_action='opened' AND e.occurred_at_ms IS NOT c.opened_at_ms)
   OR (e.recovery_action<>'opened' AND (e.recovery_action IS NOT c.state OR e.occurred_at_ms IS NOT c.closed_at_ms))))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- recovery-evidence-preflight:end -->

<!-- recovery-evidence-copy:start -->

```sql
ALTER TABLE support_recovery_cases ADD COLUMN opened_event_id TEXT;
ALTER TABLE support_recovery_cases ADD COLUMN opened_event_row_ref TEXT CHECK((opened_event_id IS NULL)=(opened_event_row_ref IS NULL));
ALTER TABLE support_recovery_cases ADD COLUMN decision_event_id TEXT;
ALTER TABLE support_recovery_cases ADD COLUMN decision_event_row_ref TEXT CHECK((decision_event_id IS NULL)=(decision_event_row_ref IS NULL));
UPDATE support_recovery_cases AS c SET
 opened_event_id=(SELECT id FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action='opened'),
 opened_event_row_ref=(SELECT CAST(sequence AS TEXT) FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action='opened'),
 decision_event_id=(SELECT id FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action=c.state),
 decision_event_row_ref=(SELECT CAST(sequence AS TEXT) FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action=c.state);
INSERT INTO audit_entries_1442(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms,refresh_connection_id,consumed_refresh_id,issued_refresh_id)
SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms,refresh_connection_id,consumed_refresh_id,issued_refresh_id FROM audit_entries WHERE record_type<>'support_recovery';
UPDATE sqlite_sequence SET seq=max(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='audit_entries'),0)) WHERE name='audit_entries_1442';
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_evidence_cutover',CASE WHEN
 (SELECT count(*) FROM audit_entries_1442)=(SELECT count(*) FROM audit_entries WHERE record_type<>'support_recovery')
 AND NOT EXISTS(SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms,refresh_connection_id,consumed_refresh_id,issued_refresh_id FROM audit_entries WHERE record_type<>'support_recovery'
 EXCEPT SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms,refresh_connection_id,consumed_refresh_id,issued_refresh_id FROM audit_entries_1442)
 AND NOT EXISTS(SELECT 1 FROM audit_entries e JOIN support_recovery_cases c ON c.id=e.recovery_case_id WHERE e.record_type='support_recovery'
   AND ((e.recovery_action='opened' AND (c.opened_event_id IS NOT e.id OR c.opened_event_row_ref IS NOT CAST(e.sequence AS TEXT)))
   OR (e.recovery_action=c.state AND (c.decision_event_id IS NOT e.id OR c.decision_event_row_ref IS NOT CAST(e.sequence AS TEXT)))))
 AND COALESCE((SELECT seq FROM sqlite_sequence WHERE name='audit_entries_1442'),0)=COALESCE((SELECT seq FROM sqlite_sequence WHERE name='audit_entries'),0)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- recovery-evidence-copy:end -->

<!-- recovery-evidence-replace:start -->

```sql
DROP TABLE audit_entries;
ALTER TABLE audit_entries_1442 RENAME TO audit_entries;
```

<!-- recovery-evidence-replace:end -->

<!-- recovery-evidence-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_evidence_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='recovery_evidence_cutover';
```

<!-- recovery-evidence-verify:end -->

## Browser pairing-to-session authority (#1443)

The target pairing and session field groups already match #1401. Retain their identities, original
instants, proof generations, Queue dispatch state, archive addresses and independent deadlines.
No table conversion or field rewriting is required. Existing unique pairing and bearer keys and
the same-User consumed-pairing insertion guard remain authoritative.

The schema additions are an expiry index for Browser Login's existing 32-row cleanup and a
WebSession owner index for User-scoped erasure. On an
existing populated database, fence authentication cleanup during installation, check foreign-key
integrity and apply the exact statements below in one native D1 batch. Stop on an unexplained
same-name schema object or invalid history; do not silently replace it. If the final baseline has
already installed both indexes, no cutover is needed. A failed batch leaves the original records and
schema intact. Publish matching code and align the one-baseline ledger after successful verification;
keep `0001_schema.sql` as the sole migration file.

<!-- browser-session-index:start -->

```sql
CREATE INDEX browser_login_pairings_retention ON browser_login_pairings(expires_at_ms,id);
CREATE INDEX web_sessions_by_user ON web_sessions(user_id);
```

<!-- browser-session-index:end -->

Session creation composes exact private-verifier consumption, same-User session insertion and a
transient `sql_assertions` check in one batch. A zero-row insertion must roll back consumption just
like an SQL error. Replay cannot mint another token. A lost success response never permits
reissuing the consumed credential; the browser starts another pairing.

Native Browser Login tests execute populated index installation, interrupted-batch rollback,
the User-scoped session archive query and
actual bounded cleanup. Session- and recovery-referenced pairings remain retained, including revoked
sessions. Existing integrated provider, WhatsApp, email and recovery journeys exercise approval and
redemption; session journeys cover freshness, sliding idle/hard expiry, revocation and logout.
State-owned email dispatch claims and ambiguous outcomes remain unchanged.

## Provider onboarding ownership (#1444)

Provider credentials retain their five fields and attempts retain their eighteen fields from #1403.
The existing onboarding composition already creates the User and original TrialPeriod, processing
Consent and extracted backup recovery credential in one native D1 batch. Provider issuer/subject
selects identity; contact email never establishes mailbox authority or merges Users. Browser Login
still requires its independent private verifier before issuing a session.

Install `provider_credential_immutable` and the expanded `provider_completion_immutable` from the
final baseline together. The former protects the original issuer, subject, owner, contact evidence
and establishment instant. The latter freezes completed attempt evidence, including its original
pairing and provider identity; it still permits the one verified-to-completed transition that clears
cookie/nonce/contact proof. Neither guard prevents purpose-authorized deletion or expired-attempt
cleanup. No table rebuild, field conversion or additional migration file is needed.

For a populated database, stop provider completion, expiry cleanup and erasure during installation,
back up the database, capture its existing trigger definitions and check for unexpected dependencies.
Run the preflight below in the same native D1 batch as dropping the old completion guard, creating
both final guards and deleting the `provider_onboarding_cutover` assertion. An unexplained preexisting
credential guard or inconsistent history requires investigation, not silent replacement or inferred
identity repair. Preserve every original rowid, field, disclosure byte, exact instant and archive
address. Retained historical attempts do not require an independently erased current credential,
Consent record or recovery credential to be recreated. New onboarding still requires all of them at
its atomic completion boundary. A pairing invalidated by five wrong private verifiers may have
cleared its current User; retain the completed attempt's historical owner without restoring pairing
authority. Publish matching code and align the one-baseline ledger only after
successful verification. Failed preflight or installation rolls the whole batch back.

<!-- provider-onboarding-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'provider_onboarding_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM provider_authentication_attempts a
   LEFT JOIN browser_login_pairings p ON p.id=a.pairing_id
   LEFT JOIN provider_credentials c ON c.issuer=a.issuer AND c.subject=a.subject
   WHERE (a.state='completed')<>(a.completed_at_ms IS NOT NULL)
   OR (a.completed_at_ms IS NOT NULL AND (
     a.user_id IS NULL OR a.issuer IS NULL OR a.subject IS NULL
     OR a.cookie_digest IS NOT zeroblob(32) OR a.nonce<>'' OR a.contact_email IS NOT NULL
     OR a.created_user IS NULL
     OR (p.state IN('ready','consumed') AND p.user_id IS NOT a.user_id)
     OR p.state NOT IN('ready','consumed','invalidated')
     OR (p.state='invalidated' AND (p.user_id IS NOT NULL OR p.wrong_attempts<>5))
     OR a.expires_at_ms<=a.completed_at_ms OR p.expires_at_ms<=a.completed_at_ms
     OR (c.user_id IS NOT NULL AND c.user_id IS NOT a.user_id))))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- provider-onboarding-preflight:end -->

Existing Google and Microsoft journeys verify nonce/cookie/issuer/subject binding, non-authoritative
contact email, duplicate completion, concurrent single-use recovery disclosure and rollback when
Consent, recovery or provider credential insertion produces no row. The populated native cutover
reuses those real journey records, refuses conflicting ownership, preserves all retained values and
archives, proves guard-installation rollback and checks the actual indexed expiry query.

## WhatsApp-to-browser handoff (#1445)

Keep the thirteen handoff fields and the separate send claim, review send, confirmation and
consumption facts from #1403. Consent owns the immutable 27-field pre-User exchange and its original
recipient/disclosure/decision proof. Provider Authentication owns the browser handoff; the public
reference is neither a decision nor a browser credential. Existing-User initial association and
conflict refusal remain unchanged. Do not add a workflow or copy the removed recipient snapshots.

Handoff consumption is now an explicit, guarded statement after provider completion in the same D1
batch. It addresses the exact completed attempt, same User, pairing and confirmed handoff, and must
change one row. Its shared changed-row assertion rolls back User, trial, Consent, recovery,
association, pairing and attempt changes if consumption fails or silently writes no row. The old
`whatsapp_provider_completion_consumes_confirmation` AFTER trigger must be removed in this same
cutover. `whatsapp_provider_completion_requires_confirmation` remains the commit-time proof guard.
The new `whatsapp_provider_handoff_immutable` guard prevents replacing the parent exchange, an
established browser binding, claimed sends, a sent review, a recorded decision or consumption.
Decision evidence retains its original message and receipt instant, including denied decisions.

For a populated database, fence handoff ingress, provider completion, expiry cleanup and erasure;
back up the database and capture existing trigger definitions. In one native D1 batch, run the
preflight below, drop the exact old consumption trigger, install the final baseline handoff
immutability guard and delete the `provider_handoff_cutover` assertion. Stop on unexplained objects
or historical inconsistency; never fabricate missing proof or infer a consumption instant. There is
no table rebuild or field rewrite, and `0001_schema.sql` remains the only migration file. Publish
matching callers and align the baseline ledger while the fence remains in place; do not run new
callers with the old trigger or old callers without it. Failed preflight or guard installation
rolls back the whole database batch.

A completed attempt's pairing can legitimately have been invalidated later, clearing its current
User. Do not use that current pairing authority to reinterpret original decision ownership.
A consumed handoff can outlive independently expired attempt correlation; absence of an already
purged attempt does not recreate a missing record. Retained linked attempts must agree with the
handoff's original pairing and exact consumption/completion instant.

<!-- provider-handoff-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'provider_handoff_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM whatsapp_provider_handoffs h
   JOIN pending_consent_exchanges e ON e.id=h.exchange_id
   WHERE e.state<>'accepted' OR e.decision_value IS NOT 'accepted' OR h.expires_at_ms>e.expires_at_ms
   OR (h.pairing_id IS NULL)<>(h.review_code IS NULL)
   OR (h.review_started_ms IS NOT NULL AND h.pairing_id IS NULL)
   OR (h.review_message_id IS NOT NULL AND h.review_started_ms IS NULL)
   OR (h.decision IS NULL AND (h.decision_message_id IS NOT NULL OR h.confirmed_at_ms IS NOT NULL))
   OR (h.decision IS NOT NULL AND (h.decision_message_id IS NULL OR h.confirmed_at_ms IS NULL
     OR h.review_message_id IS NULL OR h.review_started_ms IS NULL OR h.pairing_id IS NULL))
   OR (h.consumed_at_ms IS NOT NULL AND h.decision IS NOT 'confirmed'))
 AND NOT EXISTS(SELECT 1 FROM provider_authentication_attempts a
   JOIN whatsapp_provider_handoffs h ON h.id=a.handoff_id
   WHERE a.pairing_id IS NOT h.pairing_id
   OR (a.completed_at_ms IS NOT NULL AND (h.decision IS NOT 'confirmed' OR h.consumed_at_ms IS NOT a.completed_at_ms))
   OR (a.completed_at_ms IS NULL AND h.consumed_at_ms IS NOT NULL))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- provider-handoff-preflight:end -->

Existing public handoff journeys exercise wrong recipient/reply, premature and repeated decisions,
uncertain review sends, handoff/browser expiry, existing association refusal, single-use browser
proof and concurrent completion. The populated native check installs the cutover on confirmed
public-journey proof, refuses missing decision evidence without rewriting it, and verifies complete
rollback after guard installation fails. All original parent, handoff and attempt fields, rowids,
User/Consent/recovery records and archive addresses remain untouched by installation.

## OAuth refresh lineage (#1446)

`oauth_credentials.replacement_refresh_id` owns the single successor of a consumed refresh proof.
The composite foreign key binds a refresh-kind successor to the same User and OAuthConnection;
unique successors, no self-link, exact issue/consumption time and nonwidening scopes are enforced.
Rotation inserts both new credentials, then consumes the old proof and binds its successor in one
D1 batch. A skipped insert or consumption rolls the whole batch back. Consumed proof stays consumed
when lineage is erased, so erasure cannot revive it. Replay still revokes the connection and appends
Consent evidence. General OAuth operation accountability remains Audit-owned; management reads only
credential-call activity, so its public shape and filtering are unchanged.

`refresh_event_id` and `refresh_event_row_ref` preserve only historical rotation IDs and original
Audit sequence archive addresses. New rotations need neither; their lineage erasure address is
`credential:<id>`. The existing `oauth_refresh_events` erasure purpose clears the link and optional
historical metadata before credential deletion. Existing generation-qualified `{}` archives remain
unchanged. These are credential-owned fields, not a new event table or a new Audit purpose.

Public-client registration, pending reviews, approved connections and operation intents retain
their existing tables, indexes and public contracts. Approval snapshots, exact redirect/resource/PKCE,
fresh browser authority, absolute authorization expiry and narrowed credential scopes are unchanged.

Back up D1 and fence OAuth exchange/refresh/management, Audit writers/retention and erasure before
conversion. Editing an already-applied baseline does not update an existing database: this is an
explicit synchronized code/schema cutover, never a baseline replay. Stop on unexplained source
history or dependencies. In particular, consumed proof without retained rotation evidence requires
investigation rather than a fabricated successor. No temporary destination may already exist.
Capture all dependent schema objects; map each to the final baseline and reject unknown triggers,
views or incoming foreign keys. Known incoming credential references are Audit's access-credential
FK and its two historical refresh references, replaced by the new credential self-reference; Audit has no incoming FK. Run the reference block once
for every existing table, substituting a validated schema identifier for `__TABLE_NAME__`.

Execute one native D1 batch:

1. Enable `PRAGMA defer_foreign_keys=ON`; run preflight and all reference checks.
2. Create the final `oauth_credentials` and `audit_entries` definitions from `0001_schema.sql` as
   `oauth_credentials_1446` and `audit_entries_1446`. Rewrite the credential self-FK to the temporary
   credential name, and the temporary Audit access FK to that same temporary credential name.
3. Run copy/verification below before dropping any original table. Preserve every credential rowid,
   digest, exact instant and scope bytes; preserve remaining Audit sequences and its high watermark.
4. Drop original Audit triggers (especially append-only delete protection), then run replacement.
   Reinstall every final index/trigger owned by either replaced table from the baseline. External
   references must still resolve to the final credential name. Run final verification and update the
   existing baseline ledger hash in the same transaction only after all checks pass.
5. Recheck foreign keys, public refresh/replay and browser management before removing the write fence.
   A failed batch preserves the entire original schema, rows, archives and migration ledger. After
   successful publication, rollback needs the preserved backup plus matching old code; code-only
   rollback is unsafe. Never rerun the historical extraction on the converted schema.

<!-- oauth-lineage-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_lineage_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_permits) AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM audit_retention_permits)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM oauth_credentials c LEFT JOIN oauth_connections g ON g.id=c.connection_id
 WHERE c.user_id IS NULL OR c.user_id IS NOT g.user_id OR c.expires_at_ms>g.expires_at_ms
 OR NOT json_valid(c.scopes_json) OR json_type(c.scopes_json)<>'array' OR json_array_length(c.scopes_json)=0
 OR EXISTS(SELECT 1 FROM json_each(c.scopes_json) s WHERE s.type<>'text' OR s.value NOT IN('read','write','dashboard')
 OR NOT EXISTS(SELECT 1 FROM json_each(g.scopes_json) a WHERE a.value=s.value)))
 AND NOT EXISTS(SELECT 1 FROM audit_entries e
 LEFT JOIN oauth_credentials c ON c.kind='refresh' AND c.id=e.consumed_refresh_id
 LEFT JOIN oauth_credentials n ON n.kind='refresh' AND n.id=e.issued_refresh_id
 WHERE e.record_type='oauth_refresh' AND (c.id IS NULL OR n.id IS NULL OR c.id=n.id
 OR c.user_id IS NOT e.user_id OR n.user_id IS NOT e.user_id
 OR c.connection_id IS NOT e.refresh_connection_id OR n.connection_id IS NOT e.refresh_connection_id
 OR c.consumed_at_ms IS NOT e.occurred_at_ms OR n.issued_at_ms IS NOT e.occurred_at_ms
 OR e.occurred_at_ms<c.issued_at_ms OR e.occurred_at_ms>=c.expires_at_ms
 OR EXISTS(SELECT 1 FROM json_each(n.scopes_json) s WHERE NOT EXISTS(SELECT 1 FROM json_each(c.scopes_json) a WHERE a.value=s.value))))
 AND NOT EXISTS(SELECT consumed_refresh_id FROM audit_entries WHERE record_type='oauth_refresh' GROUP BY consumed_refresh_id HAVING count(*)<>1)
 AND NOT EXISTS(SELECT issued_refresh_id FROM audit_entries WHERE record_type='oauth_refresh' GROUP BY issued_refresh_id HAVING count(*)<>1)
 AND NOT EXISTS(SELECT 1 FROM oauth_credentials c WHERE c.kind='refresh' AND c.consumed_at_ms IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM audit_entries e WHERE e.record_type='oauth_refresh' AND e.consumed_refresh_id=c.id))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- oauth-lineage-preflight:end -->

<!-- oauth-lineage-references:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_lineage_cutover',CASE WHEN NOT EXISTS(
 SELECT 1 FROM pragma_foreign_key_list('__TABLE_NAME__')
 WHERE "table"='audit_entries' OR ("table"='oauth_credentials' AND NOT (
 '__TABLE_NAME__'='audit_entries' AND (("from"='oauth_credential_id' AND "to"='access_id')
 OR ("from" IN('consumed_refresh_id','issued_refresh_id') AND "to"='refresh_id'))))
) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- oauth-lineage-references:end -->

<!-- oauth-lineage-copy:start -->

```sql
INSERT INTO oauth_credentials_1446(rowid,kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,consumed_at_ms,scopes_json,replacement_refresh_id,refresh_event_id,refresh_event_row_ref)
SELECT c.rowid,c.kind,c.id,c.connection_id,c.user_id,c.digest,c.issued_at_ms,c.expires_at_ms,c.consumed_at_ms,c.scopes_json,e.issued_refresh_id,e.id,CAST(e.sequence AS TEXT)
FROM oauth_credentials c LEFT JOIN audit_entries e ON e.record_type='oauth_refresh' AND c.kind='refresh' AND e.consumed_refresh_id=c.id;
INSERT INTO audit_entries_1446(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms) SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms FROM audit_entries WHERE record_type<>'oauth_refresh';
UPDATE sqlite_sequence SET seq=(SELECT seq FROM sqlite_sequence WHERE name='audit_entries') WHERE name='audit_entries_1446';
INSERT INTO sqlite_sequence(name,seq) SELECT 'audit_entries_1446',seq FROM sqlite_sequence WHERE name='audit_entries'
 AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='audit_entries_1446');
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_lineage_cutover',CASE WHEN
 (SELECT count(*) FROM oauth_credentials)=(SELECT count(*) FROM oauth_credentials_1446)
 AND NOT EXISTS(SELECT rowid,kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,consumed_at_ms,scopes_json FROM oauth_credentials EXCEPT SELECT rowid,kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,consumed_at_ms,scopes_json FROM oauth_credentials_1446)
 AND (SELECT count(*) FROM audit_entries WHERE record_type='oauth_refresh')=(SELECT count(*) FROM oauth_credentials_1446 WHERE replacement_refresh_id IS NOT NULL)
 AND NOT EXISTS(SELECT sequence,id,user_id,refresh_connection_id,consumed_refresh_id,issued_refresh_id,occurred_at_ms FROM audit_entries WHERE record_type='oauth_refresh'
 EXCEPT SELECT CAST(refresh_event_row_ref AS INTEGER),refresh_event_id,user_id,connection_id,id,replacement_refresh_id,consumed_at_ms FROM oauth_credentials_1446 WHERE replacement_refresh_id IS NOT NULL)
 AND (SELECT count(*) FROM audit_entries WHERE record_type<>'oauth_refresh')=(SELECT count(*) FROM audit_entries_1446)
 AND NOT EXISTS(SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms FROM audit_entries WHERE record_type<>'oauth_refresh' EXCEPT SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms FROM audit_entries_1446)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- oauth-lineage-copy:end -->

<!-- oauth-lineage-replace:start -->

```sql
DROP TABLE audit_entries;
DROP TABLE oauth_credentials;
ALTER TABLE oauth_credentials_1446 RENAME TO oauth_credentials;
ALTER TABLE audit_entries_1446 RENAME TO audit_entries;
```

<!-- oauth-lineage-replace:end -->

<!-- oauth-lineage-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_lineage_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='oauth_lineage_cutover';
```

<!-- oauth-lineage-verify:end -->

## Exact OAuth operation approvals (#1447)

`oauth_operation_intents` retains the agreed twelve fields and existing indexes, expiry cleanup,
capacity, erasure address and deletion ordering. There is no table extraction or data copy. The new
`oauth_intent_initial` guard requires the connection's same User and an initially absent browser
proof. `oauth_intent_immutable` protects the exact review bytes, digest, revision bindings,
disclosure and lifetime. Its only update is one same-User browser-session approval during that
original lifetime. Approval does not consume the intent or execute the operation; its guarded DELETE,
owner revision checks, live credential scope/Consent, mutation and Audit still commit together.

Canonical policy continues to select browser-proof requirements for each operation and every batch
child. A browser decision before review creation is refused without recording approval. Native
continuation also rejects future review/approval timestamps relative to its current Clock. A browser
session's later logout does not retroactively cancel its recorded decision; the current OAuth
credential/grant, scope, Consent and owner revision must still hold when the operation commits.
Existing work remains bounded by its original five-minute deadline.

For an existing database, first apply the synchronized #1429, #1438 and #1446 changes. Back up D1
and fence intent issuance, browser decisions, sensitive continuations, expiration cleanup and erasure.
Inspect dependencies and stop on unexplained guards rather than replacing them. Execute the preflight,
the two final guard definitions from `0001_schema.sql`, and final verification in one native D1 batch;
align the existing baseline ledger only after verification. The preflight accepts expired or revoked
pending work with coherent historical relationships; it does not invent approval or refresh authority.
Foreign ownership, partial proof, or an approval outside its original lifetime stops installation.
A failed batch preserves all original intent fields, rows, archives and schema. Validate a public
review/approval/continuation against the matching new code before removing the write fence. Reverting
the two guards and matching code is sufficient for this additive guard installation; never rewrite
reviewed bytes or extend an existing approval to repair bad history.

<!-- oauth-intent-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_intent_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_permits) AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM oauth_operation_intents i WHERE
  NOT EXISTS(SELECT 1 FROM oauth_connections g WHERE g.id=i.connection_id AND g.user_id=i.user_id)
  OR (i.browser_approved_at_ms IS NULL)<>(i.browser_session_id IS NULL)
  OR (i.browser_approved_at_ms IS NOT NULL AND (
   typeof(i.browser_approved_at_ms)<>'integer' OR i.browser_approved_at_ms<i.created_at_ms OR i.browser_approved_at_ms>=i.expires_at_ms
   OR NOT EXISTS(SELECT 1 FROM web_sessions s WHERE s.id=i.browser_session_id AND s.user_id=i.user_id))))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- oauth-intent-preflight:end -->

<!-- oauth-intent-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_intent_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='oauth_intent_cutover';
```

<!-- oauth-intent-verify:end -->

## PAT grant integration (#1448)

Tokens retains `pats` (fourteen fields) and `pat_pairings` (fifteen fields). Audit owns activity;
Consent owns grant/revocation evidence; Resource Admission owns source counters and rolling browser
review events. The #1433 and #1438 conversions must already be verified before this cutover.
No additional issuance counter, consent flag or compatibility table is introduced. Existing active
capacity (100) and issuance protection (20 per User per ten minutes), source admission, rolling
review protection, private proof and polling slowdown retain their original semantics.

A paired issuance now commits the exact recipient, scopes, selected lifetime, approval anchor and
absolute expiry used to prepare its response. The final insert guard checks those facts against the
same-User claimed pairing, with issuance inside both original deadlines and at or after approval.
A changed grant aborts the complete claim/issuance/Audit batch, leaving its original proof retryable.
Approval remains the lifetime anchor; `issued_at_ms` records the later claim for issuance-window
accounting. Manual issuance still requires a fresh WebSession. Pairing approval still permits a live
same-User WebSession; claim requires the original private proof. Revocation evidence, credential
changes and Audit remain one unit. Neither a retry nor activity discloses a stored bearer or renews
its expiry.

For an existing D1 database, back up and fence PAT issuance, pairing creation/review/approval/claim,
protected PAT operations, revocation, maintenance and erasure. Inspect the installed dependencies and
confirm `paired_pat_requires_claim` is the original guard from the preceding schema; stop on
unexplained differences. Execute the following preflight, `DROP TRIGGER paired_pat_requires_claim`,
the replacement definition from `0001_schema.sql`, and final verification in **one native D1 batch**.
There is no row copy or archive-address change. Historical shorter PAT expiries are retained exactly,
including paired PATs shorter than their approved maximum; new claims must use the exact approved
expiry. Foreign ownership, inconsistent Consent references, changed reviewed grants and claims
outside their original deadlines stop the cutover. Do not repair them by rewriting approval,
issuance, lifetime or expiry. A failed batch restores both records and the preceding guard.

After verification, align the existing baseline ledger, deploy matching code and exercise manual and
paired issuance, activity and revocation before removing the fence. Do not replay the baseline on an
existing database. Revert the guard and matching code together if rollback is required; preserve all
recorded identities, digests, origins, exact instants and Consent/Audit references.

<!-- pat-grants-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'pat_grants_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_permits) AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM pat_pairings q WHERE
  (q.approved_at_ms IS NOT NULL AND (q.approved_at_ms<q.created_at_ms OR q.approved_at_ms>=q.expires_at_ms
   OR NOT EXISTS(SELECT 1 FROM consent_history g WHERE g.record_type='pat_grant'
    AND g.pairing_id=q.id AND g.user_id=q.user_id AND g.occurred_at_ms=q.approved_at_ms))))
 AND NOT EXISTS(SELECT 1 FROM pats p WHERE p.expires_at_ms<=p.issued_at_ms
  OR (p.request_id IS NOT NULL AND (p.created_at_ms<>p.issued_at_ms
   OR NOT EXISTS(SELECT 1 FROM consent_history g WHERE g.record_type='pat_grant'
    AND g.request_id=p.request_id AND g.user_id=p.user_id AND g.occurred_at_ms=p.created_at_ms)))
  OR (p.pairing_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pat_pairings q
   WHERE q.id=p.pairing_id AND q.user_id=p.user_id AND q.state='claimed'
    AND q.approved_at_ms=p.created_at_ms AND q.expires_at_ms>p.issued_at_ms
    AND q.pat_expires_at_ms>=p.expires_at_ms AND p.issued_at_ms>=q.approved_at_ms
    AND q.recipient_label=p.recipient_label AND q.scopes_json=p.scopes_json AND q.lifetime_days=p.lifetime_days)))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- pat-grants-preflight:end -->

<!-- pat-grants-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'pat_grants_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='pat_grants_cutover';
```

<!-- pat-grants-verify:end -->

## Subscription enrollment and reusable sources (#1449)

`subscriptions` now owns the stable `(id,user_id)` identity formerly in `users.subscription_id`.
An enrollment and its Subscription reservation commit together. Existing issued Subscription IDs
are preserved; an owner with enrollment history but no issued Subscription receives one new stable
identity during extraction. Free/trial Users without enrollment history need no row. The selected
paid-attempt pointer and the remaining paid-standing copies are the separate #1450 slice; this
branch is the integration branch for that dependent work, not a compatibility release.

`payment_enrollments` has the accepted twenty fields. `payment_sources` has nine domain fields plus
`archive_row_ref`, preserving the original source erasure address. Candidate IDs remain on enrollment;
only authenticated verified observations establish a reusable source. Composite deferred foreign keys
bind a source and its original enrollment to the same Subscription. An inserted verified source binds
its origin in that same native statement; reuse resolves the existing active source, never a new
source or origin. Method/environment and original source facts are immutable. Retirement retains the
existing failed-card, cleared-attempt and no-paid-standing requirements. Provider candidate and source
identities are unique within their recorded environment. Proof lifetime, browser freshness, acceptance
binding, lookup cooldowns/eight-check budget and ambiguous-creation behavior are unchanged.

The read-only `payment_enrollment_context` and `payment_source_context` projections resolve User
ownership through Subscription for the owning adapter's reads and guards. They hold no state and
have no write triggers. All mutations address the final tables. No old enrollment/source view remains.
Erasure keeps the purpose identifiers `card_enrollments`, `card_payment_sources` and
`subscription_identities`, original archive body keys and row addresses. Source erasure first clears
resolved enrollment references, then deletes the selected sources; origin enrollments follow, then
the Subscription identity. Billing/refund/cancellation history is disposed in its existing order.

For existing D1, back up and fence enrollment, billing/renewal/settlement, refunds, cancellation,
price publication, erasure and User creation. Complete the preceding identity/authentication cutovers.
Inventory every table, view, trigger, index and incoming foreign key against the preceding baseline;
stop on unknown dependencies or schema differences. This cutover also replaces the incoming source
FKs in `billing_attempts` and `users`, and the Subscription FK in `refund_attempts`. Do not replay
the baseline. The `source-cutover` native test executes the following plan against populated native D1.

In **one native D1 batch**:

1. Enable deferred foreign keys, run `subscription-source-preflight`, and require a clean FK check.
2. Create the final `subscriptions`, `payment_enrollments` and `payment_sources` tables from the
   baseline, without their indexes/triggers yet. Create final `users`, `billing_attempts` and
   `refund_attempts` definitions under `_1449` shadow names, changing only each CREATE TABLE name.
   Keep all incoming references addressed to their final table names.
3. Run `subscription-source-copy`. Copy each shadow table using an explicit manifest of its final
   non-generated columns from `PRAGMA table_xinfo`, preserving original rowid and every retained
   column byte-for-byte. `users.subscription_id` is the sole removed User column; generated paid
   identity helpers are recomputed from their unchanged inputs. No billing/refund fact is removed.
4. Run `subscription-source-copy-check` before dropping originals. Preserve the original schema
   inventory for rollback and verify each shadow table's rowid/common-column sets with bidirectional
   EXCEPT. Preserve all unrelated tables, archives, migration-ledger rows and sequence watermarks.
5. Drop inventoried views/triggers and explicit indexes (never SQLite autoindexes), then drop the
   original `card_enrollments`, `users`, `billing_attempts`, `refund_attempts`. Rename shadows to their
   final names. Reinstall all final views/triggers/indexes from the baseline, including erasure guards.
6. Run `subscription-source-verify`, then align the existing baseline ledger in the same unit only
   after verification. Any failure restores all original rows, schema and archives. After success,
   rollback requires the backup and matching old code. Publish matching code and verify enrollment,
   retry/reuse, retirement, billing and erasure before removing the fence.

Missing source environments are resolved only from a single recorded billing environment for that
exact source; never from current deployment configuration. A source with unknown/conflicting history,
changed method/billing context, or a reuse enrollment with ambiguous source references stops the batch.
The extraction performs no provider mutation and never invents acceptance or verification evidence.

<!-- subscription-source-preflight:start -->

```sql
PRAGMA defer_foreign_keys=ON;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription_source_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_permits) AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM card_enrollments e WHERE e.payment_source_id IS NOT NULL AND (
  e.source_method<>e.method OR e.source_billing_email<>e.billing_email
  OR (e.wompi_environment IS NULL AND (SELECT count(DISTINCT a.wompi_environment) FROM billing_attempts a WHERE a.payment_source_id=e.payment_source_id)<>1)
  OR EXISTS(SELECT 1 FROM billing_attempts a WHERE a.payment_source_id=e.payment_source_id
   AND (a.user_id<>e.user_id OR (e.wompi_environment IS NOT NULL AND a.wompi_environment<>e.wompi_environment)))))
 AND NOT EXISTS(SELECT 1 FROM billing_attempts a WHERE NOT EXISTS(SELECT 1 FROM card_enrollments e
  JOIN card_enrollments origin ON origin.payment_source_id=a.payment_source_id
  WHERE e.id=a.enrollment_id AND e.user_id=a.user_id AND origin.user_id=a.user_id
   AND e.method=origin.source_method AND (e.wompi_environment IS NULL OR e.wompi_environment=a.wompi_environment)))
 AND NOT EXISTS(SELECT 1 FROM card_enrollments e WHERE
  (e.status='available' AND e.payment_source_id IS NULL AND (SELECT count(DISTINCT a.payment_source_id) FROM billing_attempts a WHERE a.enrollment_id=e.id)<>1)
  OR (SELECT count(DISTINCT a.payment_source_id) FROM billing_attempts a WHERE a.enrollment_id=e.id)>1)
 AND NOT EXISTS(SELECT 1 FROM refund_attempts r JOIN users u ON u.id=r.user_id WHERE u.subscription_id IS NOT r.subscription_id)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- subscription-source-preflight:end -->

<!-- subscription-source-copy:start -->

```sql
INSERT INTO subscriptions(rowid,id,user_id)
SELECT u.rowid,COALESCE(u.subscription_id,lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))),u.id
FROM users u WHERE u.subscription_id IS NOT NULL OR EXISTS(SELECT 1 FROM card_enrollments e WHERE e.user_id=u.id);
INSERT INTO payment_enrollments(rowid,id,subscription_id,price_id,billing_email,status,payment_source_mode,contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,accepted_at_ms,payment_request_id,wompi_candidate_source_id,verification_attempts,last_verification_at_ms,refusal_reason,method,wompi_environment,authorization_digest,payment_source_id)
SELECT e.rowid,e.id,s.id,e.price_id,e.billing_email,e.status,e.payment_source_mode,e.contracts_json,e.disclosure_json,e.prepared_at_ms,e.expires_at_ms,e.accepted_at_ms,e.payment_request_id,e.wompi_candidate_source_id,e.verification_attempts,e.last_verification_at_ms,e.refusal_reason,e.method,COALESCE(e.wompi_environment,(SELECT a.wompi_environment FROM billing_attempts a WHERE a.enrollment_id=e.id LIMIT 1)),e.authorization_digest,COALESCE(e.payment_source_id,(SELECT a.payment_source_id FROM billing_attempts a WHERE a.enrollment_id=e.id LIMIT 1))
FROM card_enrollments e JOIN subscriptions s ON s.user_id=e.user_id;
INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_environment,wompi_source_id,billing_email,method,verified_at_ms,retired_at_ms,archive_row_ref)
SELECT e.payment_source_id,s.id,e.id,COALESCE(e.wompi_environment,(SELECT a.wompi_environment FROM billing_attempts a WHERE a.payment_source_id=e.payment_source_id LIMIT 1)),e.source_wompi_id,e.source_billing_email,e.source_method,e.source_created_at_ms,e.source_retired_at_ms,COALESCE(e.source_row_ref,'source:'||e.payment_source_id)
FROM card_enrollments e JOIN subscriptions s ON s.user_id=e.user_id WHERE e.payment_source_id IS NOT NULL;
```

<!-- subscription-source-copy:end -->

<!-- subscription-source-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription_source_cutover',CASE WHEN
 (SELECT count(*) FROM card_enrollments)=(SELECT count(*) FROM payment_enrollments)
 AND (SELECT count(*) FROM card_enrollments WHERE payment_source_id IS NOT NULL)=(SELECT count(*) FROM payment_sources)
 AND NOT EXISTS(SELECT rowid,subscription_id,id FROM users WHERE subscription_id IS NOT NULL
  EXCEPT SELECT rowid,id,user_id FROM subscriptions)
 AND NOT EXISTS(SELECT e.rowid,e.id,e.user_id,e.price_id,e.billing_email,e.status,e.payment_source_mode,e.contracts_json,e.disclosure_json,e.prepared_at_ms,e.expires_at_ms,e.accepted_at_ms,e.payment_request_id,e.wompi_candidate_source_id,e.verification_attempts,e.last_verification_at_ms,e.refusal_reason,e.method,e.authorization_digest FROM card_enrollments e
  EXCEPT SELECT e.rowid,e.id,s.user_id,e.price_id,e.billing_email,e.status,e.payment_source_mode,e.contracts_json,e.disclosure_json,e.prepared_at_ms,e.expires_at_ms,e.accepted_at_ms,e.payment_request_id,e.wompi_candidate_source_id,e.verification_attempts,e.last_verification_at_ms,e.refusal_reason,e.method,e.authorization_digest FROM payment_enrollments e JOIN subscriptions s ON s.id=e.subscription_id)
 AND NOT EXISTS(SELECT e.payment_source_id,e.user_id,e.id,e.source_wompi_id,e.source_billing_email,e.source_method,e.source_created_at_ms,e.source_retired_at_ms,COALESCE(e.source_row_ref,'source:'||e.payment_source_id) FROM card_enrollments e WHERE e.payment_source_id IS NOT NULL
  EXCEPT SELECT p.id,s.user_id,p.origin_enrollment_id,p.wompi_source_id,p.billing_email,p.method,p.verified_at_ms,p.retired_at_ms,p.archive_row_ref FROM payment_sources p JOIN subscriptions s ON s.id=p.subscription_id)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- subscription-source-copy-check:end -->

<!-- subscription-source-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription_source_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM payment_enrollments e JOIN payment_sources p ON p.id=e.payment_source_id
  WHERE e.subscription_id<>p.subscription_id OR e.method<>p.method OR e.wompi_environment IS NOT p.wompi_environment)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='subscription_source_cutover';
PRAGMA defer_foreign_keys=OFF;
```

<!-- subscription-source-verify:end -->

## Subscription paid standing and billing facts — #1450

Subscription selects one same-Subscription awarded BillingAttempt. User retains its original trial;
Price supplies immutable Money and commercial terms. `billing_attempt_context` is a read-only owner
projection, including historical archive keys, and holds no copied state. Intended renewal windows
and verified awarded windows remain distinct. Cancellation and refund stops retain their existing
meaning and are not reset by enrollment or an older settlement.

For a populated database, fence all ordinary/background writers and provider publication, take a
restorable backup and inventory every dependent schema object. Stop on any unexplained divergence.
Do not replay the fresh-install baseline or infer historical values from the current environment.
Use one native D1 batch with deferred foreign keys. Create `users_1450`, `subscriptions_1450` and
`billing_attempts_1450` from the schema checkpoint at commit `8d5d210e7` (after #1450 and
before #1452 removes cancellation fields), rather than the later final baseline, by changing only the
CREATE TABLE name and redirect references to replaced Subscriptions and BillingAttempts to their
shadow names. Keep all User references pointing to the original users table. Execute preflight and copy below,
compare every copied row and exact rowid with its source, then remove dependent triggers/views/indexes,
drop only the old subscriptions and billing_attempts tables, rename those two shadows to their final
names, execute the User column-removal block below and reinstall all final schema objects. Users
remain in place so cascading child data cannot be deleted. users_1450 is a validated copy only.
Preserve every other row and existing erasure archive verbatim. Any failure must roll back the entire
batch. Test interruption after copying and after replacement; retain the backup until #1494's full
release verification is complete. Subsequent deployment must use this matching schema and code.

<!-- subscription-standing-preflight:start -->

```sql
PRAGMA defer_foreign_keys=ON;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-commercial',NOT EXISTS (
 SELECT 1 FROM billing_attempts a LEFT JOIN subscription_prices p ON p.id=a.price_id
 WHERE p.id IS NULL OR a.amount IS NOT p.amount OR a.currency IS NOT p.currency
 OR a.billing_period IS NOT p.billing_period OR a.service_market IS NOT p.service_market
 OR a.tax_treatment IS NOT p.tax_treatment);
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-owner',NOT EXISTS (
 SELECT 1 FROM billing_attempts a LEFT JOIN subscriptions s ON s.user_id=a.user_id
 LEFT JOIN payment_enrollments e ON e.id=a.enrollment_id
 LEFT JOIN payment_sources source ON source.id=a.payment_source_id
 LEFT JOIN billing_attempts prior ON prior.id=a.previous_paid_attempt_id
 WHERE s.id IS NULL OR e.subscription_id IS NOT s.id OR source.subscription_id IS NOT s.id
 OR source.wompi_environment IS NOT a.wompi_environment
 OR (a.previous_paid_attempt_id IS NOT NULL AND (prior.user_id IS NOT a.user_id OR prior.paid_starts_at_ms IS NULL)));
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-selected',NOT EXISTS (
 SELECT 1 FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id
 LEFT JOIN billing_attempts a ON a.id=u.paid_attempt_id
 WHERE (u.paid_attempt_id IS NULL AND (u.paid_price_id IS NOT NULL OR u.paid_period_ends_at_ms IS NOT NULL OR u.paid_renewal_anchor_ms IS NOT NULL))
 OR (u.paid_attempt_id IS NOT NULL AND (s.id IS NULL OR a.user_id IS NOT u.id OR a.status IS NOT 'succeeded'
 OR a.paid_starts_at_ms IS NULL OR u.paid_price_id IS NOT a.price_id
 OR u.paid_period_ends_at_ms IS NOT a.paid_ends_at_ms OR u.paid_renewal_anchor_ms IS NOT a.paid_renewal_anchor_ms)));
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-no-charge',NOT EXISTS (
 SELECT 1 FROM billing_attempts a WHERE
 (a.no_charge_confirmed_at_ms IS NULL AND (a.no_charge_reference IS NOT NULL OR a.no_charge_environment IS NOT NULL OR a.no_charge_case_id IS NOT NULL OR a.no_charge_operator_id IS NOT NULL))
 OR (a.no_charge_confirmed_at_ms IS NOT NULL AND (a.no_charge_reference IS NOT a.wompi_reference OR a.no_charge_environment IS NOT a.wompi_environment OR a.no_charge_case_id IS NULL OR a.no_charge_operator_id IS NULL))
 OR ((a.recovery_case_id IS NULL)<>(a.recovery_reviewed_at_ms IS NULL))
 OR (a.recovery_reviewed_at_ms IS NOT NULL AND (a.recovery_case_id IS NOT a.no_charge_case_id OR a.no_charge_confirmed_at_ms IS NULL OR a.status IS NOT 'succeeded')));
```

<!-- subscription-standing-preflight:end -->

<!-- subscription-standing-copy:start -->

```sql
INSERT INTO users_1450(rowid,id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms,forwarding_address_id,forwarding_local_part,forwarding_issued_at_ms,backfill_present,backfill_submission_id,backfill_consumed_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms,route_portfolio_id,route_bsuid,route_phone_number_id,route_verified_at_ms,cancellation_paid_attempt_id,cancellation_payment_source_id,cancellation_cancelled_at_ms,cancellation_paid_through_ms,cancellation_source_cancellation,cancellation_void_started_at_ms,cancellation_void_verified_at_ms,cancellation_verification_count,cancellation_last_offered_at_ms)
SELECT r.rowid,r.id,r.service_market,r.locale,r.time_zone,r.created_at_ms,r.trial_started_at_ms,r.trial_ends_at_ms,r.forwarding_address_id,r.forwarding_local_part,r.forwarding_issued_at_ms,r.backfill_present,r.backfill_submission_id,r.backfill_consumed_at_ms,r.whatsapp_portfolio_id,r.whatsapp_bsuid,r.whatsapp_verified_at_ms,r.route_portfolio_id,r.route_bsuid,r.route_phone_number_id,r.route_verified_at_ms,r.cancellation_paid_attempt_id,r.cancellation_payment_source_id,r.cancellation_cancelled_at_ms,r.cancellation_paid_through_ms,r.cancellation_source_cancellation,r.cancellation_void_started_at_ms,r.cancellation_void_verified_at_ms,r.cancellation_verification_count,r.cancellation_last_offered_at_ms FROM users r;
INSERT INTO subscriptions_1450(rowid,id,user_id,current_paid_attempt_id)
SELECT r.rowid,r.id,r.user_id,(SELECT paid_attempt_id FROM users WHERE id=r.user_id) FROM subscriptions r;
INSERT INTO billing_attempts_1450(rowid,id,subscription_id,enrollment_id,payment_request_id,payment_source_id,price_id,time_zone,wompi_environment,wompi_reference,status,created_at_ms,finalized_at_ms,previous_paid_attempt_id,period_starts_at_ms,period_ends_at_ms,calendar_anchor_ms,renewal_attempt_number,paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms,checkout_transaction_id,collection_state,collection_sent_at_ms,collection_last_attempt_at_ms,followup_due_at_ms,no_charge_case_id,no_charge_operator_id,no_charge_confirmed_at_ms,late_approval_observed_at_ms)
SELECT r.rowid,r.id,(SELECT id FROM subscriptions WHERE user_id=r.user_id),r.enrollment_id,r.payment_request_id,r.payment_source_id,r.price_id,r.time_zone,r.wompi_environment,r.wompi_reference,r.status,r.created_at_ms,r.finalized_at_ms,r.previous_paid_attempt_id,r.period_starts_at_ms,r.period_ends_at_ms,r.calendar_anchor_ms,r.renewal_attempt_number,r.paid_starts_at_ms,r.paid_ends_at_ms,r.paid_renewal_anchor_ms,r.checkout_transaction_id,r.collection_state,r.collection_sent_at_ms,r.collection_last_attempt_at_ms,r.followup_due_at_ms,r.no_charge_case_id,r.no_charge_operator_id,r.no_charge_confirmed_at_ms,r.recovery_reviewed_at_ms FROM billing_attempts r;
```

<!-- subscription-standing-copy:end -->

<!-- subscription-standing-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) SELECT 'subscription-standing-copy-users',
 (SELECT count(*) FROM users)=(SELECT count(*) FROM users_1450) AND NOT EXISTS (
 SELECT 1 FROM users r LEFT JOIN users_1450 t ON t.rowid=r.rowid WHERE t.rowid IS NULL OR t.id IS NOT r.id
 OR t.service_market IS NOT r.service_market
 OR t.locale IS NOT r.locale
 OR t.time_zone IS NOT r.time_zone
 OR t.created_at_ms IS NOT r.created_at_ms
 OR t.trial_started_at_ms IS NOT r.trial_started_at_ms
 OR t.trial_ends_at_ms IS NOT r.trial_ends_at_ms
 OR t.forwarding_address_id IS NOT r.forwarding_address_id
 OR t.forwarding_local_part IS NOT r.forwarding_local_part
 OR t.forwarding_issued_at_ms IS NOT r.forwarding_issued_at_ms
 OR t.backfill_present IS NOT r.backfill_present
 OR t.backfill_submission_id IS NOT r.backfill_submission_id
 OR t.backfill_consumed_at_ms IS NOT r.backfill_consumed_at_ms
 OR t.whatsapp_portfolio_id IS NOT r.whatsapp_portfolio_id
 OR t.whatsapp_bsuid IS NOT r.whatsapp_bsuid
 OR t.whatsapp_verified_at_ms IS NOT r.whatsapp_verified_at_ms
 OR t.route_portfolio_id IS NOT r.route_portfolio_id
 OR t.route_bsuid IS NOT r.route_bsuid
 OR t.route_phone_number_id IS NOT r.route_phone_number_id
 OR t.route_verified_at_ms IS NOT r.route_verified_at_ms
 OR t.cancellation_paid_attempt_id IS NOT r.cancellation_paid_attempt_id
 OR t.cancellation_payment_source_id IS NOT r.cancellation_payment_source_id
 OR t.cancellation_cancelled_at_ms IS NOT r.cancellation_cancelled_at_ms
 OR t.cancellation_paid_through_ms IS NOT r.cancellation_paid_through_ms
 OR t.cancellation_source_cancellation IS NOT r.cancellation_source_cancellation
 OR t.cancellation_void_started_at_ms IS NOT r.cancellation_void_started_at_ms
 OR t.cancellation_void_verified_at_ms IS NOT r.cancellation_void_verified_at_ms
 OR t.cancellation_verification_count IS NOT r.cancellation_verification_count
 OR t.cancellation_last_offered_at_ms IS NOT r.cancellation_last_offered_at_ms);
INSERT INTO sql_assertions(scope,accepted) SELECT 'subscription-standing-copy-subscriptions',
 (SELECT count(*) FROM subscriptions)=(SELECT count(*) FROM subscriptions_1450) AND NOT EXISTS (
 SELECT 1 FROM subscriptions r LEFT JOIN subscriptions_1450 t ON t.rowid=r.rowid WHERE t.rowid IS NULL OR t.id IS NOT r.id
 OR t.user_id IS NOT r.user_id
 OR t.current_paid_attempt_id IS NOT (SELECT paid_attempt_id FROM users WHERE id=r.user_id));
INSERT INTO sql_assertions(scope,accepted) SELECT 'subscription-standing-copy-billing_attempts',
 (SELECT count(*) FROM billing_attempts)=(SELECT count(*) FROM billing_attempts_1450) AND NOT EXISTS (
 SELECT 1 FROM billing_attempts r LEFT JOIN billing_attempts_1450 t ON t.rowid=r.rowid WHERE t.rowid IS NULL OR t.id IS NOT r.id
 OR t.subscription_id IS NOT (SELECT id FROM subscriptions WHERE user_id=r.user_id)
 OR t.enrollment_id IS NOT r.enrollment_id
 OR t.payment_request_id IS NOT r.payment_request_id
 OR t.payment_source_id IS NOT r.payment_source_id
 OR t.price_id IS NOT r.price_id
 OR t.time_zone IS NOT r.time_zone
 OR t.wompi_environment IS NOT r.wompi_environment
 OR t.wompi_reference IS NOT r.wompi_reference
 OR t.status IS NOT r.status
 OR t.created_at_ms IS NOT r.created_at_ms
 OR t.finalized_at_ms IS NOT r.finalized_at_ms
 OR t.previous_paid_attempt_id IS NOT r.previous_paid_attempt_id
 OR t.period_starts_at_ms IS NOT r.period_starts_at_ms
 OR t.period_ends_at_ms IS NOT r.period_ends_at_ms
 OR t.calendar_anchor_ms IS NOT r.calendar_anchor_ms
 OR t.renewal_attempt_number IS NOT r.renewal_attempt_number
 OR t.paid_starts_at_ms IS NOT r.paid_starts_at_ms
 OR t.paid_ends_at_ms IS NOT r.paid_ends_at_ms
 OR t.paid_renewal_anchor_ms IS NOT r.paid_renewal_anchor_ms
 OR t.checkout_transaction_id IS NOT r.checkout_transaction_id
 OR t.collection_state IS NOT r.collection_state
 OR t.collection_sent_at_ms IS NOT r.collection_sent_at_ms
 OR t.collection_last_attempt_at_ms IS NOT r.collection_last_attempt_at_ms
 OR t.followup_due_at_ms IS NOT r.followup_due_at_ms
 OR t.no_charge_case_id IS NOT r.no_charge_case_id
 OR t.no_charge_operator_id IS NOT r.no_charge_operator_id
 OR t.no_charge_confirmed_at_ms IS NOT r.no_charge_confirmed_at_ms
 OR t.late_approval_observed_at_ms IS NOT r.recovery_reviewed_at_ms);
```

<!-- subscription-standing-copy-check:end -->

<!-- subscription-standing-user-remove:start -->

```sql
DROP TABLE users_1450;
ALTER TABLE users DROP COLUMN paid_renewal_anchor_ms;
ALTER TABLE users DROP COLUMN paid_period_ends_at_ms;
ALTER TABLE users DROP COLUMN paid_price_id;
ALTER TABLE users DROP COLUMN paid_attempt_id;
```

<!-- subscription-standing-user-remove:end -->

<!-- subscription-standing-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-final-owner',NOT EXISTS (
 SELECT 1 FROM subscriptions s JOIN billing_attempts a ON a.id=s.current_paid_attempt_id
 WHERE a.subscription_id<>s.id OR a.status<>'succeeded' OR a.paid_starts_at_ms IS NULL);
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-final-fks',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);
PRAGMA defer_foreign_keys=OFF;
```

<!-- subscription-standing-verify:end -->

Native cutover evidence preserves rowids, selected standing, immutable Price values, intended and
awarded periods, no-charge and late approval observations, provider evidence and retained archives.
The paid-access lookup uses unique Subscription/User and attempt/Price keys; renewal discovery gains
a due-work index rather than scanning historical attempts. Compare EXPLAIN QUERY PLAN before/after with representative populated data.
History lookup has `(subscription_id,created_at_ms DESC,id DESC)` support. Renewal/grace, sibling
races and late approval continue through the existing public workflows; commercial quotas remain
unchanged. The existing provider workflow telemetry remains at the same orchestration boundary.

## Billing observation executions (#1451)

Provider observations now launch `billing-lookup-v2-<digest>` for the retained transaction and signed
hint generation. The digest includes the exact provider-native signed timestamp and status; it has
no wall-clock bucket. The payload contains only these identities. A lost launch response is recovered with `get` and native status inspection of that same execution id. Queued, running, waiting and paused executions keep their existing reservation; scheduler reoffers do not charge them again. A terminal execution with remaining eligible budget is restarted only after a new atomic prelaunch reservation.

Discovery rotates bounded batches independently of the provider lookup clocks so queued or paused
executions cannot permanently occupy the oldest batch. Each execution has at most eight named
lookup steps separated by native durable cooldown sleeps.
The initial reservation remains charged before handoff, including failed handoffs. Later steps
atomically reserve the applicable attempt and callback budgets before provider GET. Neither a new
execution nor an engine replacement resets those counters. A newer signed hint resets only its
callback budget and changes the execution identity; an older generation cannot charge that budget
or mark the replacement hint resolved. Verified provider evidence, with the original environment,
reference, source, amount and finalization checks, remains the only settlement authority.

No schema or historical-row rewrite is needed. Existing v1 lookup executions retain their original
one-step meaning during their existing three-day retention; new offers use v2. Do not manually
restart an existing execution with its old charged payload. Recovery reoffers the retained database
identity through the dispatcher, preserving its cumulative charging and deadline guards. Final live
verification remains part of #1494.

## Retained Subscription cancellation (#1452)

Cancellation moves nine nullable User fields into the ten-field `subscription_cancellations` table.
Its Subscription key and composite paid-attempt/source references enforce one owner. The read-only
context supplies User identity and preserves existing archive keys. New rows keep the original User
rowid, so retained archive locators remain unchanged. A cancellation remains a renewal stop after
source replacement; it never revokes the already awarded paid period.

Fence ordinary writers and take the same verified backup required above. Create the final empty
`subscription_cancellations` table from the baseline. Execute the following blocks, removal of
schema objects that depend on the old cancellation columns, and reinstallation of final views,
indexes and triggers in one native atomic batch. Copy and validate before dropping columns.
Drop `cancellation_last_offered_at_ms` first because its inline CHECK owns the old grouped-absence
constraint. Dropping columns in place preserves the User table, rowids and every cascading child;
this cutover does not drop or rename Users. Never disable foreign keys. Retain archives unchanged.

<!-- subscription-cancellation-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-cancellation-preflight',CASE WHEN NOT EXISTS (
 SELECT 1 FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id
 LEFT JOIN billing_attempts a ON a.id=u.cancellation_paid_attempt_id
 LEFT JOIN payment_sources p ON p.id=u.cancellation_payment_source_id
 WHERE u.cancellation_cancelled_at_ms IS NOT NULL AND (
  s.id IS NULL OR a.id IS NULL OR p.id IS NULL OR a.subscription_id IS NOT s.id
  OR p.subscription_id IS NOT s.id OR a.payment_source_id IS NOT p.id
  OR a.status<>'succeeded' OR a.paid_starts_at_ms IS NULL
  OR u.cancellation_paid_through_ms>a.paid_ends_at_ms
  OR u.cancellation_verification_count NOT BETWEEN 0 AND 8
  OR u.cancellation_source_cancellation NOT IN ('detached','void-pending','voided')
 )) THEN 1 ELSE 0 END;
```

<!-- subscription-cancellation-preflight:end -->

<!-- subscription-cancellation-copy:start -->

```sql
INSERT INTO subscription_cancellations(rowid,subscription_id,paid_attempt_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation_state,void_started_at_ms,void_verified_at_ms,verification_count,last_offered_at_ms)
SELECT u.rowid,s.id,u.cancellation_paid_attempt_id,u.cancellation_payment_source_id,u.cancellation_cancelled_at_ms,u.cancellation_paid_through_ms,u.cancellation_source_cancellation,u.cancellation_void_started_at_ms,u.cancellation_void_verified_at_ms,u.cancellation_verification_count,u.cancellation_last_offered_at_ms FROM users u JOIN subscriptions s ON s.user_id=u.id WHERE u.cancellation_cancelled_at_ms IS NOT NULL;
```

<!-- subscription-cancellation-copy:end -->

<!-- subscription-cancellation-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-cancellation-copy',CASE WHEN
 (SELECT count(*) FROM subscription_cancellations)=(SELECT count(*) FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM users u JOIN subscriptions s ON s.user_id=u.id
 LEFT JOIN subscription_cancellations c ON c.subscription_id=s.id
 WHERE u.cancellation_cancelled_at_ms IS NOT NULL AND (c.rowid IS NOT u.rowid
  OR c.paid_attempt_id IS NOT u.cancellation_paid_attempt_id
  OR c.payment_source_id IS NOT u.cancellation_payment_source_id
  OR c.cancelled_at_ms IS NOT u.cancellation_cancelled_at_ms
  OR c.paid_through_ms IS NOT u.cancellation_paid_through_ms
  OR c.source_cancellation_state IS NOT u.cancellation_source_cancellation
  OR c.void_started_at_ms IS NOT u.cancellation_void_started_at_ms
  OR c.void_verified_at_ms IS NOT u.cancellation_void_verified_at_ms
  OR c.verification_count IS NOT u.cancellation_verification_count
  OR c.last_offered_at_ms IS NOT u.cancellation_last_offered_at_ms
)) THEN 1 ELSE 0 END;
```

<!-- subscription-cancellation-copy-check:end -->

<!-- subscription-cancellation-remove:start -->

```sql
ALTER TABLE users DROP COLUMN cancellation_last_offered_at_ms;
ALTER TABLE users DROP COLUMN cancellation_verification_count;
ALTER TABLE users DROP COLUMN cancellation_void_verified_at_ms;
ALTER TABLE users DROP COLUMN cancellation_void_started_at_ms;
ALTER TABLE users DROP COLUMN cancellation_source_cancellation;
ALTER TABLE users DROP COLUMN cancellation_paid_through_ms;
ALTER TABLE users DROP COLUMN cancellation_cancelled_at_ms;
ALTER TABLE users DROP COLUMN cancellation_payment_source_id;
ALTER TABLE users DROP COLUMN cancellation_paid_attempt_id;
```

<!-- subscription-cancellation-remove:end -->

<!-- subscription-cancellation-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-cancellation-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
```

<!-- subscription-cancellation-verify:end -->

Cleanup uses `source-cancel-v2-<UserId>` with eight bounded native lookup steps and durable waits.
Queue publication retains its original offer clock. The void mutation still needs its one durable
claim; an ambiguous void is never repeated. Each source GET reserves the existing cumulative
verification counter. Active executions are deduplicated; terminal executions may restart only
while pending work and remaining budget exist. Every step reloads the retained original source and
same-environment binding, so a replacement source cannot redirect the cleanup. Existing v1
executions retain their one-step meaning for the existing three-day retention. #1494 owns final
live cutover verification.

## Subscription refunds (#1453)

Apply after #1452 on its verified schema checkpoint `0297fbaa0`. Keep rollback evidence and existing
archive bodies unchanged. Install the target `refund_charge_context` view, then execute the preflight,
create the target refund table as `refund_attempts_1453`, copy, and compare. In the same D1 batch,
drop all existing explicit views/triggers/indexes and the newly installed charge view, swap only the
refund table, reinstall target views/triggers/indexes, and check foreign keys. Do not drop User,
Subscription, charge, or Price tables. A failed assertion or interrupted batch rolls everything back.
The clean baseline remains one file; this populated cutover does not replay it against existing data.

The target has 24 logical fields plus one generated owner key. The generated `user_id` comes from the
validated immutable request and is constrained against the charge owner at acceptance. This retains
per-User retry uniqueness across different charges. Original charge value uses validated decimal
text and integer arithmetic; no floating-point conversion is used for Money. Provider refund identity
is unique within its environment. Retained treatment replaces the duplicated response; original
response identities, exact Money and instants are checked before any copies disappear. The
write-only publication timestamp is intentionally discarded; dispatch cooldown, claims, verification
budgets, ambiguous reservations and verified access/renewal effects remain. Native migration tests
exercise populated replay, preservation and rollback; #1494 owns final live cutover verification.

<!-- subscription-refund-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-refund-preflight',CASE WHEN NOT EXISTS(
 SELECT 1 FROM refund_attempts r LEFT JOIN refund_charge_context a ON a.id=r.billing_attempt_id
 WHERE a.id IS NULL OR r.user_id IS NOT a.user_id OR r.subscription_id IS NOT a.subscription_id
 OR r.original_cents IS NOT a.original_cents
 OR json_extract(r.intent_json,'$.userId') IS NOT r.user_id
 OR json_extract(r.intent_json,'$.billingAttemptId') IS NOT r.billing_attempt_id
 OR json_extract(r.intent_json,'$.requestId') IS NOT r.request_id
 OR json_extract(r.intent_json,'$.intent.kind') IS NOT r.kind
 OR json_extract(r.snapshot_json,'$.id') IS NOT r.id
 OR json_extract(r.snapshot_json,'$.userId') IS NOT r.user_id
 OR json_extract(r.snapshot_json,'$.subscriptionId') IS NOT r.subscription_id
 OR json_extract(r.snapshot_json,'$.billingAttemptId') IS NOT r.billing_attempt_id
 OR json_extract(r.snapshot_json,'$.priceId') IS NOT a.price_id
 OR json_extract(r.snapshot_json,'$.kind') IS NOT r.kind
 OR json_extract(r.snapshot_json,'$.requestId') IS NOT r.request_id
 OR json_extract(r.snapshot_json,'$.reason') IS NOT json_extract(r.intent_json,'$.reason')
 OR json_extract(r.snapshot_json,'$.reason') NOT IN('user-request','duplicate-collection','service-error')
 OR json_extract(r.snapshot_json,'$.money.currency') IS NOT a.currency
 OR json_extract(r.snapshot_json,'$.money.amount') IS NOT
   (CAST(CAST(r.amount_in_cents/100 AS INTEGER) AS TEXT)||CASE WHEN r.amount_in_cents%100=0 THEN '' ELSE '.'||rtrim(printf('%02d',r.amount_in_cents%100),'0') END)
 OR (r.kind='refund' AND (json_extract(r.intent_json,'$.intent.money.amount') IS NOT json_extract(r.snapshot_json,'$.money.amount')
   OR json_extract(r.intent_json,'$.intent.money.currency') IS NOT a.currency))
 OR (r.kind='card-void' AND r.amount_in_cents<>a.original_cents)
 OR json_extract(r.snapshot_json,'$.createdAt') IS NOT
   (strftime('%Y-%m-%dT%H:%M:%S',CAST(r.created_at_ms/1000 AS INTEGER),'unixepoch')||printf('.%03dZ',r.created_at_ms%1000))
 OR json_extract(r.snapshot_json,'$.status') IS NOT 'pending'
 OR json_extract(r.snapshot_json,'$.progress') IS NOT 'queued'
 OR json_extract(r.snapshot_json,'$.treatment.policyId') IS NOT 'refund-ends-paid-period-v1'
 OR json_extract(r.snapshot_json,'$.treatment.taxTreatment') IS NOT a.tax_treatment
 OR json_extract(r.snapshot_json,'$.treatment.paidPeriodEffect') IS NOT 'end-refunded-period-at-verification'
 OR json_extract(r.snapshot_json,'$.treatment.renewalEffect') IS NOT 'stop-future-renewals'
 OR json_extract(r.snapshot_json,'$.treatment.accounting.kind') IS NOT 'sandbox-only'
 OR (r.adjusted_attempt_id IS NOT NULL AND r.adjusted_attempt_id IS NOT r.billing_attempt_id)
 OR (r.renewal_stopped_user_id IS NOT NULL AND r.renewal_stopped_user_id IS NOT r.user_id)
 OR NOT EXISTS(SELECT 1 FROM billing_provider_transactions e WHERE e.transaction_id=r.transaction_id AND e.attempt_id=r.billing_attempt_id AND e.status='APPROVED')
 OR a.wompi_environment<>'sandbox' OR a.status<>'succeeded' OR a.paid_starts_at_ms IS NULL
 OR (SELECT COUNT(*) FROM billing_provider_transactions e WHERE e.attempt_id=a.id AND e.status='APPROVED')<>1
 OR (r.kind='card-void' AND NOT EXISTS(SELECT 1 FROM payment_source_context p WHERE p.id=a.payment_source_id AND p.method='card'))
 OR (r.status='succeeded' AND (r.verified_status NOT IN('APPROVED','VOIDED') OR r.observed_at_ms IS NULL OR r.finalized_at_ms IS NOT r.observed_at_ms OR r.access_ends_at_ms IS NOT r.observed_at_ms OR r.renewal_stopped_at_ms IS NOT r.observed_at_ms))
 OR (r.status='failed' AND (r.verified_status NOT IN('DECLINED','CANCELLED') OR r.observed_at_ms IS NULL OR r.finalized_at_ms IS NOT r.observed_at_ms))
 OR (SELECT SUM(other.amount_in_cents) FROM refund_attempts other WHERE other.billing_attempt_id=r.billing_attempt_id AND other.status<>'failed')>a.original_cents
) THEN 1 ELSE 0 END;
```

<!-- subscription-refund-preflight:end -->

<!-- subscription-refund-copy:start -->

```sql
INSERT INTO refund_attempts_1453(rowid,id,billing_attempt_id,wompi_environment,transaction_id,request_id,intent_json,treatment_json,amount_in_cents,kind,operator_id,created_at_ms,status,progress,finalized_at_ms,failure,dispatch_last_attempt_at_ms,verification_attempts,last_verification_at_ms,submission_claimed_at_ms,provider_refund_id,verified_status,observed_at_ms,access_ends_at_ms,renewal_stopped_at_ms)
 SELECT r.rowid,r.id,r.billing_attempt_id,a.wompi_environment,r.transaction_id,r.request_id,r.intent_json,json_extract(r.snapshot_json,'$.treatment'),r.amount_in_cents,r.kind,r.operator_id,r.created_at_ms,r.status,r.progress,r.finalized_at_ms,r.failure,r.dispatch_last_attempt_at_ms,r.verification_attempts,r.last_verification_at_ms,r.submission_claimed_at_ms,r.provider_refund_id,r.verified_status,r.observed_at_ms,r.access_ends_at_ms,r.renewal_stopped_at_ms
 FROM refund_attempts r JOIN refund_charge_context a ON a.id=r.billing_attempt_id;
```

<!-- subscription-refund-copy:end -->

<!-- subscription-refund-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-refund-copy',CASE WHEN NOT EXISTS(
 SELECT rowid,id,billing_attempt_id,wompi_environment,transaction_id,request_id,intent_json,treatment_json,amount_in_cents,kind,operator_id,created_at_ms,status,progress,finalized_at_ms,failure,dispatch_last_attempt_at_ms,verification_attempts,last_verification_at_ms,submission_claimed_at_ms,provider_refund_id,verified_status,observed_at_ms,access_ends_at_ms,renewal_stopped_at_ms FROM refund_attempts_1453
 EXCEPT SELECT r.rowid,r.id,r.billing_attempt_id,a.wompi_environment,r.transaction_id,r.request_id,r.intent_json,json_extract(r.snapshot_json,'$.treatment'),r.amount_in_cents,r.kind,r.operator_id,r.created_at_ms,r.status,r.progress,r.finalized_at_ms,r.failure,r.dispatch_last_attempt_at_ms,r.verification_attempts,r.last_verification_at_ms,r.submission_claimed_at_ms,r.provider_refund_id,r.verified_status,r.observed_at_ms,r.access_ends_at_ms,r.renewal_stopped_at_ms FROM refund_attempts r JOIN refund_charge_context a ON a.id=r.billing_attempt_id
) AND (SELECT COUNT(*) FROM refund_attempts_1453)=(SELECT COUNT(*) FROM refund_attempts) THEN 1 ELSE 0 END;
```

<!-- subscription-refund-copy-check:end -->

<!-- subscription-refund-swap:start -->

```sql
DROP TABLE refund_attempts;
ALTER TABLE refund_attempts_1453 RENAME TO refund_attempts;
```

<!-- subscription-refund-swap:end -->

<!-- subscription-refund-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-refund-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
```

<!-- subscription-refund-verify:end -->

## Subscription price notices (#1454)

Apply after #1453 at verified checkpoint `9e4e7a965`. In one D1 batch run the preflight,
create the target table as `billing_price_notices_1454`, copy and compare, drop explicit
views/triggers/indexes, swap only the notice table, reinstall target views/triggers/indexes,
and verify foreign keys. Preserve original rowids and archive bodies. Missing Subscription
ownership blocks the conversion; never invent it or discard the notice. User and Subscription
tables remain in place.

The six-field store is keyed by Subscription/Price. `provider_accepted_at_ms` records email
provider acknowledgment, not User approval of a Price. The queue still carries the resolved User
and exact Price; reads derive User ownership through Subscription and every write scopes the
same Subscription. Offer cooldown and durable send claims retain their meaning: definitive refusal
can release a claim for retry, while timeout or an ambiguous provider response leaves it claimed.
Renewal admission does not acquire a Price-approval requirement. Erasure removes notices before
their Subscription identity. #1494 owns final live cutover verification.

<!-- subscription-price-notice-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-price-notice-preflight',CASE WHEN NOT EXISTS(
 SELECT 1 FROM billing_price_notices n LEFT JOIN subscriptions s ON s.user_id=n.user_id
 WHERE s.id IS NULL OR (n.accepted_at_ms IS NOT NULL AND n.send_started_at_ms IS NULL)
) THEN 1 ELSE 0 END;
```

<!-- subscription-price-notice-preflight:end -->

<!-- subscription-price-notice-copy:start -->

```sql
INSERT INTO billing_price_notices_1454(rowid,subscription_id,price_id,created_at_ms,last_offered_at_ms,send_started_at_ms,provider_accepted_at_ms)
SELECT n.rowid,s.id,n.price_id,n.created_at_ms,n.last_offered_at_ms,n.send_started_at_ms,n.accepted_at_ms
FROM billing_price_notices n JOIN subscriptions s ON s.user_id=n.user_id;
```

<!-- subscription-price-notice-copy:end -->

<!-- subscription-price-notice-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-price-notice-copy',CASE WHEN NOT EXISTS(
 SELECT rowid,subscription_id,price_id,created_at_ms,last_offered_at_ms,send_started_at_ms,provider_accepted_at_ms FROM billing_price_notices_1454
 EXCEPT SELECT n.rowid,s.id,n.price_id,n.created_at_ms,n.last_offered_at_ms,n.send_started_at_ms,n.accepted_at_ms FROM billing_price_notices n JOIN subscriptions s ON s.user_id=n.user_id
) AND (SELECT COUNT(*) FROM billing_price_notices_1454)=(SELECT COUNT(*) FROM billing_price_notices) THEN 1 ELSE 0 END;
```

<!-- subscription-price-notice-copy-check:end -->

<!-- subscription-price-notice-swap:start -->

```sql
DROP TABLE billing_price_notices;
ALTER TABLE billing_price_notices_1454 RENAME TO billing_price_notices;
```

<!-- subscription-price-notice-swap:end -->

<!-- subscription-price-notice-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-price-notice-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
```

<!-- subscription-price-notice-verify:end -->

## Forwarding address extraction (#1456)

Source checkpoint: `1217883c0`, after Subscription and allowance integration. The accepted
`forwarding_addresses` record owns `id`, unique `user_id`, unique `local_part`, and `issued_at_ms`.
Issuance remains in the processing-grant transaction. An address routes email; it supplies no
browser-login, mailbox-credential, or canonical caller authority. Admission still rechecks current
Consent and institution Connection eligibility before retaining bytes.

With writers quiesced, run the following in one native D1 batch: preflight, create the exact target
`forwarding_addresses` definition from the baseline, copy and compare, remove the source checkpoint's
explicit views/triggers/indexes, swap, recreate the target baseline's views/triggers/indexes, then
verify. Keep implicit constraint indexes. Do not drop/rebuild User or disable foreign keys.
A failure rolls back the complete batch. #1494 owns final live cutover verification.

Preserve each original User rowid as the new address rowid so the logical
`email_forwarding_addresses` erasure store's existing chunk references remain valid. Its archive
shape retains `created_at_ms` as the historical serialization of the original issuance instant;
existing archives are not rewritten. User rows without an address remain absent. No allowance or
email-receipt state moves. The new Consent trigger retains an existing address on a later grant.

<!-- forwarding-address-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'forwarding-address-preflight',CASE WHEN NOT EXISTS(
 SELECT 1 FROM users WHERE
 (forwarding_address_id IS NULL OR forwarding_local_part IS NULL OR forwarding_issued_at_ms IS NULL)
 AND (forwarding_address_id IS NOT NULL OR forwarding_local_part IS NOT NULL OR forwarding_issued_at_ms IS NOT NULL)
) THEN 1 ELSE 0 END;
```

<!-- forwarding-address-preflight:end -->

<!-- forwarding-address-copy:start -->

```sql
INSERT INTO forwarding_addresses(rowid,id,user_id,local_part,issued_at_ms)
SELECT rowid,forwarding_address_id,id,forwarding_local_part,forwarding_issued_at_ms
FROM users WHERE forwarding_address_id IS NOT NULL;
```

<!-- forwarding-address-copy:end -->

<!-- forwarding-address-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'forwarding-address-copy',CASE WHEN NOT EXISTS(
 SELECT rowid,id,user_id,local_part,issued_at_ms FROM forwarding_addresses
 EXCEPT SELECT rowid,forwarding_address_id,id,forwarding_local_part,forwarding_issued_at_ms
 FROM users WHERE forwarding_address_id IS NOT NULL
) AND (SELECT COUNT(*) FROM forwarding_addresses)=(SELECT COUNT(*) FROM users WHERE forwarding_address_id IS NOT NULL)
THEN 1 ELSE 0 END;
```

<!-- forwarding-address-copy-check:end -->

<!-- forwarding-address-swap:start -->

```sql
ALTER TABLE users DROP COLUMN forwarding_issued_at_ms;
ALTER TABLE users DROP COLUMN forwarding_local_part;
ALTER TABLE users DROP COLUMN forwarding_address_id;
```

<!-- forwarding-address-swap:end -->

<!-- forwarding-address-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'forwarding-address-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
```

<!-- forwarding-address-verify:end -->

## Statement materialization extraction (#1457)

Source checkpoint: `6adb8d86d`. Parsed cache metadata moves to `statement_materializations`;
its parts reference that cache row. Submission identity, captured parser/format/market/locale/zone,
parse-attempt budget, durable cursor, row outcomes, final totals and work reconciliation stay on the
submission. Cache publication still verifies ordered part hashes, total bytes and dimensions before
processing. A corrupt cache cannot reinterpret or undo already captured rows. Terminal settlement
removes cache and parts atomically; native Workflow reconciliation remains independent of parsing.

Quiesce writers. In one D1 batch: preflight; create the exact baseline cache table and a
`statement_materialization_parts_1457` copy of the target parts definition; copy and compare; drop
explicit source views/triggers/indexes; swap; recreate baseline views/triggers/indexes; verify.
Keep constraint indexes. Do not rebuild the submission or disable foreign keys. The old submission
rowid becomes cache rowid and every original part rowid is preserved. Historical archive bodies
remain unchanged; new cache archives use their own ingestion store. Erasure removes parts before
cache, then submission, retaining purpose-specific guards. #1494 owns final live verification.

<!-- statement-materialization-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-materialization-preflight',CASE WHEN NOT EXISTS(
 SELECT 1 FROM statement_submissions s LEFT JOIN statement_staging_objects o ON o.id=s.staging_id
 WHERE (s.material_state IS NULL AND (s.material_source_sha256 IS NOT NULL OR s.material_parts_sha256 IS NOT NULL
 OR s.material_representation_revision IS NOT NULL OR s.material_expires_at_ms IS NOT NULL OR s.material_headers_json IS NOT NULL
 OR s.material_row_count IS NOT NULL OR s.material_part_count IS NOT NULL OR s.material_byte_length IS NOT NULL))
 OR (s.material_state IS NOT NULL AND (s.material_source_sha256 IS NULL OR s.material_parts_sha256 IS NULL
 OR s.material_representation_revision IS NULL OR s.material_expires_at_ms IS NULL OR s.material_headers_json IS NULL
 OR s.material_row_count IS NULL OR s.material_part_count IS NULL OR s.material_byte_length IS NULL
 OR s.material_source_sha256 IS NOT o.sha256 OR s.material_expires_at_ms IS NOT s.retention_expires_at_ms
 OR s.parser_revision IS NULL OR s.source_format IS NULL OR s.service_market IS NULL OR s.locale IS NULL OR s.time_zone IS NULL
 OR s.status NOT IN ('queued','processing')
 OR (s.material_state='ready' AND (s.material_part_count<>(SELECT COUNT(*) FROM statement_materialization_parts p WHERE p.submission_id=s.id)
 OR s.material_byte_length IS NOT (SELECT SUM(length(CAST(body AS BLOB))) FROM statement_materialization_parts p WHERE p.submission_id=s.id)))))
) AND NOT EXISTS(SELECT 1 FROM statement_materialization_parts p LEFT JOIN statement_submissions s ON s.id=p.submission_id
 WHERE s.id IS NULL OR s.material_state IS NULL) THEN 1 ELSE 0 END;
```

<!-- statement-materialization-preflight:end -->

<!-- statement-materialization-copy:start -->

```sql
INSERT INTO statement_materializations(rowid,submission_id,source_sha256,parts_sha256,representation_revision,expires_at_ms,headers_json,row_count,part_count,byte_length,state)
SELECT rowid,id,material_source_sha256,material_parts_sha256,material_representation_revision,material_expires_at_ms,material_headers_json,material_row_count,material_part_count,material_byte_length,material_state
FROM statement_submissions WHERE material_state IS NOT NULL;
INSERT INTO statement_materialization_parts_1457(rowid,submission_id,chunk_index,part_index,body,sha256)
SELECT rowid,submission_id,chunk_index,part_index,body,sha256 FROM statement_materialization_parts;
```

<!-- statement-materialization-copy:end -->

<!-- statement-materialization-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-materialization-copy',CASE WHEN NOT EXISTS(
 SELECT rowid,submission_id,source_sha256,parts_sha256,representation_revision,expires_at_ms,headers_json,row_count,part_count,byte_length,state FROM statement_materializations
 EXCEPT SELECT rowid,id,material_source_sha256,material_parts_sha256,material_representation_revision,material_expires_at_ms,material_headers_json,material_row_count,material_part_count,material_byte_length,material_state FROM statement_submissions WHERE material_state IS NOT NULL
) AND (SELECT COUNT(*) FROM statement_materializations)=(SELECT COUNT(*) FROM statement_submissions WHERE material_state IS NOT NULL)
AND NOT EXISTS(SELECT rowid,submission_id,chunk_index,part_index,body,sha256 FROM statement_materialization_parts_1457
 EXCEPT SELECT rowid,submission_id,chunk_index,part_index,body,sha256 FROM statement_materialization_parts)
AND (SELECT COUNT(*) FROM statement_materialization_parts_1457)=(SELECT COUNT(*) FROM statement_materialization_parts)
THEN 1 ELSE 0 END;
```

<!-- statement-materialization-copy-check:end -->

<!-- statement-materialization-swap:start -->

```sql
DROP TABLE statement_materialization_parts;
ALTER TABLE statement_materialization_parts_1457 RENAME TO statement_materialization_parts;
ALTER TABLE statement_submissions DROP COLUMN material_state;
ALTER TABLE statement_submissions DROP COLUMN material_byte_length;
ALTER TABLE statement_submissions DROP COLUMN material_part_count;
ALTER TABLE statement_submissions DROP COLUMN material_row_count;
ALTER TABLE statement_submissions DROP COLUMN material_headers_json;
ALTER TABLE statement_submissions DROP COLUMN material_expires_at_ms;
ALTER TABLE statement_submissions DROP COLUMN material_representation_revision;
ALTER TABLE statement_submissions DROP COLUMN material_parts_sha256;
ALTER TABLE statement_submissions DROP COLUMN material_source_sha256;
```

<!-- statement-materialization-swap:end -->

<!-- statement-materialization-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-materialization-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
```

<!-- statement-materialization-verify:end -->

Native processing-cost examples after cache extraction read 2,258 rows for 96 processed source rows
and 4,460 for 192, versus 2,247 and 4,437 at the preceding checkpoint. The existing native linear
cost and bounded-chunk checks remain green; cache reads add indexed parent joins without rescanning
unrelated submissions or rereading source bytes on resume.

## Statement review ownership (#1458)

Checkpoint: `013bd1b24`. Pause ingestion, review mutations, retention and erasure workers for
this atomic cutover. Email and media retain their existing stores until #1459. The statement
variant moves into `ingestion_review_items`; `statement_review_context` and
`ingestion_review_workspace_state` are read-only owner projections, not extra copies.

Read the current definitions from the checked-out baseline. In one D1 batch: run preflight;
drop explicit views/triggers/indexes; create the target table and all current explicit indexes
(including same-User parent keys); copy and compare; remove migrated overlays and the old evidence table;
recreate all current explicit views/triggers;
verify foreign keys. Do not drop User, submission, Transaction or archive tables. Apply this
stage after #1457 and before #1459. Any failed assertion rolls back the whole batch.

Original evidence rowids become target rowids. Original workspace rowids are independently
retained as `workspace_archive_row_ref`, so existing `ingestion_review_state` chunks/archives
remain meaningful. Workspace edits cannot recreate deleted evidence or change its deadline.
A skipped workspace still counts toward the 5,000 retained statement-evidence capacity;
only evidence settlement, expiry or deletion releases that capacity. Workspace history expires
independently. Existing archives remain byte-for-byte unchanged.

<!-- statement-review-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-review-preflight',CASE WHEN
NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND (SELECT pending_count FROM statement_review_capacity WHERE id=1)=
 (SELECT count(*) FROM statement_needs_review WHERE status='pending')
AND NOT EXISTS(SELECT 1 FROM statement_needs_review r JOIN ingestion_review_state w ON w.user_id=r.user_id AND w.id=r.id
 WHERE w.created_at_ms IS NOT r.created_at_ms OR w.expires_at_ms IS NOT r.evidence_expires_at_ms)
AND NOT EXISTS(SELECT 1 FROM statement_needs_review r JOIN forwarded_email_receipts e ON e.user_id=r.user_id AND e.review_id=r.id)
AND NOT EXISTS(SELECT 1 FROM statement_needs_review r JOIN media_submissions m ON m.user_id=r.user_id AND m.id=r.id AND m.review_reason IS NOT NULL)
THEN 1 ELSE 0 END;
```

<!-- statement-review-preflight:end -->

<!-- statement-review-copy:start -->

```sql
INSERT INTO ingestion_review_items(rowid,id,user_id,source_kind,statement_submission_id,record_number,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,original_evidence,known_money_json,issues_json,evidence_state,suggestions_json,workspace_state,workspace_revision,draft_json,transaction_id,workspace_updated_at_ms,workspace_archive_row_ref)
SELECT r.rowid,r.id,r.user_id,'statement',r.submission_id,r.record_number,r.reason,r.created_at_ms,r.evidence_expires_at_ms,r.service_market,r.locale,r.time_zone,r.source_format,r.parser_revision,r.extractor_revision,r.original_evidence,r.known_money,r.issues,CASE r.status WHEN 'pending' THEN 'retained' ELSE r.status END,r.review_suggestions_json,w.status,w.revision,w.draft_json,w.transaction_id,w.updated_at_ms,CAST(w.rowid AS TEXT)
FROM statement_needs_review r LEFT JOIN ingestion_review_state w ON w.user_id=r.user_id AND w.id=r.id;
```

<!-- statement-review-copy:end -->

<!-- statement-review-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-review-copy',CASE WHEN
(SELECT count(*) FROM ingestion_review_items)=(SELECT count(*) FROM statement_needs_review)
AND NOT EXISTS(SELECT rowid,id,user_id,submission_id,record_number,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,original_evidence,known_money,issues,status,review_suggestions_json FROM statement_needs_review
EXCEPT SELECT rowid,id,user_id,statement_submission_id,record_number,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,original_evidence,known_money_json,issues_json,CASE evidence_state WHEN 'retained' THEN 'pending' ELSE evidence_state END,suggestions_json FROM ingestion_review_items)
AND NOT EXISTS(SELECT CAST(w.rowid AS TEXT),w.id,w.user_id,w.status,w.revision,w.draft_json,w.transaction_id,w.updated_at_ms FROM ingestion_review_state w JOIN statement_needs_review r ON r.user_id=w.user_id AND r.id=w.id
EXCEPT SELECT workspace_archive_row_ref,id,user_id,workspace_state,workspace_revision,draft_json,transaction_id,workspace_updated_at_ms FROM ingestion_review_items WHERE workspace_updated_at_ms IS NOT NULL)
THEN 1 ELSE 0 END;
```

<!-- statement-review-copy-check:end -->

<!-- statement-review-swap:start -->

```sql
DELETE FROM ingestion_review_state WHERE (user_id,id) IN(SELECT user_id,id FROM ingestion_review_items);
DROP TABLE statement_needs_review;
```

<!-- statement-review-swap:end -->

<!-- statement-review-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-review-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND (SELECT pending_count FROM statement_review_capacity WHERE id=1)=(SELECT count(*) FROM ingestion_review_items WHERE source_kind='statement' AND evidence_state='retained')
AND NOT EXISTS(SELECT 1 FROM ingestion_review_state w JOIN ingestion_review_items r ON r.user_id=w.user_id AND r.id=w.id)
THEN 1 ELSE 0 END;
```

<!-- statement-review-verify:end -->

## Email and media review ownership (#1459)

Checkpoint: `1bfb570bd`, after #1458. Quiesce all ingestion, review, retention and erasure
execution during this atomic conversion. All sources use `ingestion_review_items`; the old
workspace table and six source-only review fields are removed. Email dispatch keeps the same
presence/sent distinction with `dispatch_pending`, removing its duplicated User key. The shared
workspace owner now writes one table without source-specific branches.

In one native D1 batch: enable deferred foreign keys; run preflight; drop explicit triggers and
views, retaining existing indexes during copying; create a `forwarded_email_receipts_1459`
shadow using the current receipt table definition with that table name; copy and compare;
drop all old explicit indexes; run the swap; recreate all current explicit indexes, views and
triggers; run final verification. Never disable foreign keys. Receipts have only NO ACTION
incoming source references; retain their exact rowids and every source-attestation reference.
Media stays in place because its admission Audit has a cascade relationship. Existing statement
review rows and all archive bodies remain in place. Any error rolls the entire native batch back.

Preflight rejects orphan or ambiguous historical overlays, altered original deadlines/creation
instants and inconsistent outcome links. Do not invent missing source ownership. Original workspace
archive references remain independent of newly allocated email/media source rowids. Metadata-only
email replay tombstones keep their original deadlines; media still releases capacity once, clears
private material at thirty days and removes accountability at one year. Workspace draft/history
expiry remains independent of original evidence expiry. Anonymized samples retain their own owner.

<!-- email-media-review-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email-media-review-preflight',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND NOT EXISTS(SELECT 1 FROM ingestion_review_state w WHERE
 (SELECT count(*) FROM forwarded_email_receipts e WHERE e.user_id=w.user_id AND e.review_id=w.id AND e.review_created_at_ms=w.created_at_ms AND e.review_evidence_expires_at_ms=w.expires_at_ms)
 +(SELECT count(*) FROM media_submissions m WHERE m.user_id=w.user_id AND m.id=w.id AND m.review_reason IS NOT NULL AND m.review_created_at_ms=w.created_at_ms AND m.expires_at_ms=w.expires_at_ms)<>1)
AND NOT EXISTS(SELECT 1 FROM forwarded_email_receipts e JOIN media_submissions m ON m.user_id=e.user_id AND m.id=e.review_id WHERE m.review_reason IS NOT NULL)
AND NOT EXISTS(SELECT 1 FROM forwarded_email_receipts e WHERE e.outcome='needs-review' AND e.outcome_review_id IS NOT e.review_id)
THEN 1 ELSE 0 END;
```

<!-- email-media-review-preflight:end -->

<!-- email-media-review-copy:start -->

```sql
INSERT INTO forwarded_email_receipts_1459(rowid,id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms,time_zone,deferred_checked_at_ms,outcome,outcome_transaction_id,outcome_review_id,outcome_completed_at_ms,dispatch_pending,dispatch_sent_at_ms) SELECT rowid,id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms,time_zone,deferred_checked_at_ms,outcome,outcome_transaction_id,outcome_review_id,outcome_completed_at_ms,(dispatch_user_id IS NOT NULL),dispatch_sent_at_ms FROM forwarded_email_receipts;
INSERT INTO ingestion_review_items(id,user_id,source_kind,email_receipt_id,media_submission_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,workspace_state,workspace_revision,draft_json,transaction_id,workspace_updated_at_ms,workspace_archive_row_ref)
SELECT r.*,w.status,w.revision,w.draft_json,w.transaction_id,w.updated_at_ms,CAST(w.rowid AS TEXT)
FROM (SELECT e.review_id AS id,e.user_id,'email' AS source_kind,e.id AS email_receipt_id,NULL AS media_submission_id,e.review_reason AS reason,e.review_created_at_ms AS created_at_ms,e.review_evidence_expires_at_ms AS evidence_expires_at_ms,'CO' AS service_market,'es-CO' AS locale,e.time_zone FROM forwarded_email_receipts e WHERE e.review_id IS NOT NULL UNION ALL SELECT m.id,m.user_id,'media',NULL,m.id,m.review_reason,m.review_created_at_ms,m.expires_at_ms,m.service_market,m.locale,m.time_zone FROM media_submissions m WHERE m.review_reason IS NOT NULL) r LEFT JOIN ingestion_review_state w ON w.user_id=r.user_id AND w.id=r.id;
```

<!-- email-media-review-copy:end -->

<!-- email-media-review-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email-media-review-copy',CASE WHEN
NOT EXISTS(SELECT rowid,id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms,time_zone,deferred_checked_at_ms,outcome,outcome_transaction_id,outcome_review_id,outcome_completed_at_ms,(dispatch_user_id IS NOT NULL),dispatch_sent_at_ms FROM forwarded_email_receipts EXCEPT SELECT rowid,id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms,time_zone,deferred_checked_at_ms,outcome,outcome_transaction_id,outcome_review_id,outcome_completed_at_ms,dispatch_pending,dispatch_sent_at_ms FROM forwarded_email_receipts_1459)
AND (SELECT count(*) FROM forwarded_email_receipts)=(SELECT count(*) FROM forwarded_email_receipts_1459)
AND NOT EXISTS(SELECT e.review_id,e.user_id,'email',e.id,NULL,e.review_reason,e.review_created_at_ms,e.review_evidence_expires_at_ms,'CO','es-CO',e.time_zone FROM forwarded_email_receipts e WHERE e.review_id IS NOT NULL UNION ALL SELECT m.id,m.user_id,'media',NULL,m.id,m.review_reason,m.review_created_at_ms,m.expires_at_ms,m.service_market,m.locale,m.time_zone FROM media_submissions m WHERE m.review_reason IS NOT NULL EXCEPT SELECT id,user_id,source_kind,email_receipt_id,media_submission_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone FROM ingestion_review_items WHERE source_kind<>'statement')
AND (SELECT count(*) FROM ingestion_review_items WHERE source_kind<>'statement')=(SELECT count(*) FROM (SELECT e.review_id,e.user_id,'email',e.id,NULL,e.review_reason,e.review_created_at_ms,e.review_evidence_expires_at_ms,'CO','es-CO',e.time_zone FROM forwarded_email_receipts e WHERE e.review_id IS NOT NULL UNION ALL SELECT m.id,m.user_id,'media',NULL,m.id,m.review_reason,m.review_created_at_ms,m.expires_at_ms,m.service_market,m.locale,m.time_zone FROM media_submissions m WHERE m.review_reason IS NOT NULL))
AND NOT EXISTS(SELECT CAST(rowid AS TEXT),id,user_id,status,revision,draft_json,transaction_id,updated_at_ms FROM ingestion_review_state EXCEPT SELECT workspace_archive_row_ref,id,user_id,workspace_state,workspace_revision,draft_json,transaction_id,workspace_updated_at_ms FROM ingestion_review_items WHERE source_kind<>'statement' AND workspace_updated_at_ms IS NOT NULL)
THEN 1 ELSE 0 END;
```

<!-- email-media-review-copy-check:end -->

<!-- email-media-review-swap:start -->

```sql
DROP TABLE forwarded_email_receipts;
ALTER TABLE forwarded_email_receipts_1459 RENAME TO forwarded_email_receipts;
DROP TABLE ingestion_review_state;
ALTER TABLE media_submissions DROP COLUMN review_created_at_ms;
ALTER TABLE media_submissions DROP COLUMN review_reason;
```

<!-- email-media-review-swap:end -->

<!-- email-media-review-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email-media-review-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND NOT EXISTS(SELECT 1 FROM forwarded_email_receipts e WHERE e.outcome='needs-review' AND NOT EXISTS(SELECT 1 FROM ingestion_review_items r WHERE r.source_kind='email' AND r.user_id=e.user_id AND r.email_receipt_id=e.id AND r.id=e.outcome_review_id))
AND (SELECT pending_count FROM statement_review_capacity WHERE id=1)=(SELECT count(*) FROM ingestion_review_items WHERE source_kind='statement' AND evidence_state='retained')
THEN 1 ELSE 0 END;
```

<!-- email-media-review-verify:end -->

## Statement entitlement and authoritative totals (#1460)

Checkpoint: `cca848e07`, after #1459. Quiesce statement publication, processing, review,
retention and erasure for one atomic conversion. `statement_backfill_entitlements` owns the optional
three-field record. User existence never grants a backfill: first accepted publication initializes
it under the existing Free/Pro policy. Available, reserved, consumed and absent states retain their
original meaning; useful partial capture consumes once, failure releases only unconsumed work.
The composite submission reference enforces the same User. Consumed historical absence of a
submission binding remains valid.

`statement_submission_context` is a read-only projection: completed submissions, and failed
submissions with positive progress, expose the three authoritative progress counters as final totals.
Queued/processing and zero-progress failures expose absent totals. Preflight blocks every historical
mismatch, including failed positive progress whose old final totals are absent. Investigate such
history before proceeding; never invent totals or silently discard a historical exception.

In one native D1 batch: defer foreign keys; run preflight; create the target entitlement table;
copy and compare exact original User rowids (which are existing logical erasure addresses); drop
explicit views, triggers and indexes; run the in-place column removals; recreate all target indexes,
views and triggers; verify foreign keys. Neither User nor submission is dropped or rebuilt, so their
children and source/review identities remain. Exact old archive JSON and chunk references remain
untouched; new archives reconstruct the same final-total fields through the projection. A failed
copy, swap or check rolls the whole batch back. Apply code and schema together. This baseline/runbook
is not evidence that an already-applied live baseline has been upgraded; final integration #1494
owns live cutover verification.

<!-- backfill-progress-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'backfill-progress-preflight',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND NOT EXISTS(SELECT 1 FROM users u WHERE (u.backfill_present IS NULL AND (u.backfill_submission_id IS NOT NULL OR u.backfill_consumed_at_ms IS NOT NULL)) OR (u.backfill_present IS NOT NULL AND u.backfill_present IS NOT 1) OR (u.backfill_submission_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM statement_submissions s WHERE s.id=u.backfill_submission_id AND s.user_id=u.id)))
AND NOT EXISTS(SELECT 1 FROM statement_submissions s WHERE processed_rows NOT BETWEEN 0 AND 20000 OR processed_rows<>processed_accepted_rows+processed_review_rows
 OR input_rows IS NOT CASE WHEN status='completed' OR (status='failed' AND processed_rows>0) THEN processed_rows END
 OR accepted_rows IS NOT CASE WHEN status='completed' OR (status='failed' AND processed_rows>0) THEN processed_accepted_rows END
 OR needs_review_rows IS NOT CASE WHEN status='completed' OR (status='failed' AND processed_rows>0) THEN processed_review_rows END)
THEN 1 ELSE 0 END;
```

<!-- backfill-progress-preflight:end -->

<!-- backfill-progress-copy:start -->

```sql
INSERT INTO statement_backfill_entitlements(rowid,user_id,submission_id,consumed_at_ms)
SELECT rowid,id,backfill_submission_id,backfill_consumed_at_ms FROM users WHERE backfill_present IS NOT NULL;
```

<!-- backfill-progress-copy:end -->

<!-- backfill-progress-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'backfill-progress-copy',CASE WHEN (SELECT count(*) FROM statement_backfill_entitlements)=(SELECT count(*) FROM users WHERE backfill_present IS NOT NULL)
AND NOT EXISTS(SELECT rowid,id,backfill_submission_id,backfill_consumed_at_ms FROM users WHERE backfill_present IS NOT NULL EXCEPT SELECT rowid,user_id,submission_id,consumed_at_ms FROM statement_backfill_entitlements)
THEN 1 ELSE 0 END;
```

<!-- backfill-progress-copy-check:end -->

<!-- backfill-progress-swap:start -->

```sql
ALTER TABLE users DROP COLUMN backfill_consumed_at_ms;
ALTER TABLE users DROP COLUMN backfill_submission_id;
ALTER TABLE users DROP COLUMN backfill_present;
ALTER TABLE statement_submissions DROP COLUMN needs_review_rows;
ALTER TABLE statement_submissions DROP COLUMN accepted_rows;
ALTER TABLE statement_submissions DROP COLUMN input_rows;
```

<!-- backfill-progress-swap:end -->

<!-- backfill-progress-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'backfill-progress-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND NOT EXISTS(SELECT 1 FROM statement_backfill_entitlements e WHERE e.submission_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM statement_submissions s WHERE s.user_id=e.user_id AND s.id=e.submission_id))
THEN 1 ELSE 0 END;
```

<!-- backfill-progress-verify:end -->

## Canonical Category keywords (#1461)

The Category catalog keeps its stable identities and presentation order. `keyword_rules` retains
six fields: rule identity, User, canonical `keyword`, Category, and integer creation/update instants.
Create/edit/list, OAuth reviewed facts and future capture use that same normalized spelling. The
existing NFD/combining-mark removal/es-CO lowercasing algorithm is unchanged; original spelling is
intentionally discarded. Rule replacement/deletion still affects future capture only.

Checkpoint: `b26dd00018bec074432b1ddda363eb172229742f`. Keep the sole fresh-install baseline;
editing it does not convert existing D1. Back up and fence rule/capture mutations, OAuth decisions,
Audit/retention and erasure. Inspect source schema and incoming dependencies; stop on unknown objects.
`keyword_rules` has no incoming foreign keys. User, Category, Transaction and archive tables stay in
place. Preserve original rule rowids, IDs, owners and Category references. Existing archive JSON is
never rewritten; new archives retain the historical keys, deriving `normalized_keyword` from the
single keyword and serializing integer instants as UTC ISO timestamps.

Before constructing one native atomic batch, page the fenced source rows in rowid order. Decode
identities and both original timestamps using the existing owning schemas. Validate the original
keyword and its canonical normalized value with `CategoryKeyword`; compare canonical normalization
with the stored normalized value. Require an exact millisecond instant: reject nonzero fractional
digits beyond the third rather than truncating them. Offset-bearing RFC 3339 instants may convert
losslessly; their public representation remains UTC ISO. Do not use SQLite lower()/NOCASE as Unicode
normalization. Do not silently repair a mismatch or choose a winner in a collision.

Run the general preflight and, **once per observed source row**, the bound row preflight below.
Its bindings are: validation accepted (1 or 0), original rowid, original keyword, canonically computed
keyword, original creation text, original update text, and the two exactly decoded epoch-millisecond
values. An invalid decode produces accepted=0 and must abort, not skip that row. The source fence
covers the entire read/validation/commit window; verify the complete source count as well.

Then create the baseline's target rule definition as `keyword_rules_1461`; copy and compare below.
Drop only the old table's explicit triggers/index, swap the rule table, reinstall all current
rule-owned indexes/triggers (including erasure/capacity guards), and verify. Keep foreign keys enabled.
Failure after either copy or replacement must roll back all rows, schema, archives and sequence
state. Preserve backups until matching code and protected CRUD/capture are verified. Old OAuth
reviews whose exact rule snapshot changed require a fresh review; no old approval gains authority.
Only align the baseline ledger after successful conversion and verification. Prefer the native
atomic query/batch path: the October 22 recovery's bulk file import rejected a larger conversion
that succeeded through the direct transaction path; local batch success alone is not live evidence.

<!-- category-keyword-preflight:start -->

```sql
PRAGMA defer_foreign_keys=ON;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'category-keyword-preflight',NOT EXISTS(SELECT 1 FROM erasure_permits)
 AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT user_id,normalized_keyword FROM keyword_rules GROUP BY user_id,normalized_keyword HAVING count(*)<>1);
```

<!-- category-keyword-preflight:end -->

<!-- category-keyword-row-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'category-keyword-row',?=1 AND EXISTS(SELECT 1 FROM keyword_rules
 WHERE rowid=? AND keyword IS ? AND normalized_keyword IS ? AND created_at IS ? AND updated_at IS ?
 AND CAST(round(unixepoch(created_at,'subsec')*1000) AS INTEGER) IS ?
 AND CAST(round(unixepoch(updated_at,'subsec')*1000) AS INTEGER) IS ?)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- category-keyword-row-preflight:end -->

<!-- category-keyword-copy:start -->

```sql
INSERT INTO keyword_rules_1461(rowid,id,user_id,keyword,category_id,created_at_ms,updated_at_ms)
SELECT rowid,id,user_id,normalized_keyword,category_id,
 CAST(round(unixepoch(created_at,'subsec')*1000) AS INTEGER),
 CAST(round(unixepoch(updated_at,'subsec')*1000) AS INTEGER) FROM keyword_rules;
```

<!-- category-keyword-copy:end -->

<!-- category-keyword-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'category-keyword-copy',(SELECT count(*) FROM keyword_rules)=(SELECT count(*) FROM keyword_rules_1461)
 AND NOT EXISTS(SELECT rowid,id,user_id,normalized_keyword,category_id,
 CAST(round(unixepoch(created_at,'subsec')*1000) AS INTEGER),
 CAST(round(unixepoch(updated_at,'subsec')*1000) AS INTEGER) FROM keyword_rules
 EXCEPT SELECT rowid,id,user_id,keyword,category_id,created_at_ms,updated_at_ms FROM keyword_rules_1461);
```

<!-- category-keyword-copy-check:end -->

<!-- category-keyword-swap:start -->

```sql
DROP TABLE keyword_rules;
ALTER TABLE keyword_rules_1461 RENAME TO keyword_rules;
```

<!-- category-keyword-swap:end -->

<!-- category-keyword-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'category-keyword-final',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);
DELETE FROM sql_assertions WHERE scope IN('category-keyword-preflight','category-keyword-row','category-keyword-copy','category-keyword-final');
PRAGMA defer_foreign_keys=OFF;
```

<!-- category-keyword-verify:end -->

## Transaction history instants (#1462)

Checkpoint: `aab97f886`. Convert the four Transactions-owned tables together. Authoritative movement,
attestation, correction and pair-decision instants become integer UTC milliseconds. Exact decimal
Money, identities, rowids, User decisions, retained source context, deletion markers and reconciliation
archive addresses stay intact. Before/after snapshot JSON and existing archives remain byte-for-byte
unchanged. The effective-fact policy orders its authoritative instants numerically and projects UTC
ISO text at the published read boundary; Dashboard query storage and public/peer cursors keep their
existing ISO contracts. This is a representation boundary, not a second timestamp authority.

Keep only `0001_schema.sql`; editing it alone never updates an existing database. Back up first and
fence ALL financial, ingestion, correction, linking, projection, retention, erasure and source writes
through the complete read/validation/commit window. Inventory incoming foreign keys, views, triggers
and explicit indexes against the checkpoint; stop on unknown dependencies or cascades. Current incoming
financial references have no delete cascades. Keep foreign keys enabled and defer them inside one
native atomic batch. No source/evidence replay or repair is part of conversion.

Read all four fenced sources in bounded rowid pages. Decode identity, Money/Currency, source-specific
historical context, User decisions, corrected-field sets and snapshot JSON through the existing owning
schemas. Require known keys and supported retained variants; investigate unexplained inconsistencies.
Every original instant must decode through UtcTimestamp with no nonzero fractional digits beyond the
third. Do not round away precision, infer a missing timezone or fix an invalid calendar date. Public
UTC normalization of a valid offset is allowed. Supply each row preflight below once per observed
row, including validation accepted (1/0), original rowid, then original text and exactly decoded
milliseconds for each instant. Never skip failed decodes. Verify observed/source counts under the fence.
After creating all four targets, run each row copy with decoded milliseconds, original rowid and
original timestamp texts; its next assertion binds rowid and the same decoded milliseconds.
Use these validated bound values directly: SQLite does not accept every offset allowed by our
owning timestamp schema (including ±15:59). Do not parse the original spelling with SQLite.
Run each table copy-check after all its rows have copied; it checks counts and all non-time facts,
while the per-row assertions check every converted instant.
Source/review uniqueness is checked before copying. Statement and email references must have the same
User. A still-retained review must agree on owner and any resolved Transaction; an absent expired review
remains historical evidence and does not acquire a destructive foreign key. New review-bound captures
must still name an existing same-User review when written.

Every linked decision must have exactly its two live members attached to that same ordered pair;
keep-separate decisions must have no attached members. Refuse inconsistent historical membership
instead of silently hiding or duplicating movements during conversion. Current linked amounts may
differ after an accepted Correction: exact Money/Currency/direction equality is a link-admission rule,
not a reason to reject later corrected facts.

Run preflight and all bound row checks first. Then temporarily drop inventoried triggers and views
inside the batch so parent replacement cannot run business effects or leave invalid view references.
Create each baseline target table as `<name>_1462`, copy and compare the complete rows below, drop ONLY
the four source tables, and rename the replacements. Reinstall the exact baseline views/triggers and
all four table-owned explicit indexes; other tables/indexes remain untouched. Verify all incoming
foreign keys, unchanged dependent/archival data and sequence state, then protected capture/history,
correction, stale-revision refusal, link/unlink and source replay. Any error, including interruption
after copy or swap, must roll back the entire unit, including removed triggers/views. Retain the backup
until code and schema verification succeeds; only then align the baseline ledger. Use the native
query/batch transaction path described above, not a bulk-import claim based solely on local tests.

<!-- transaction-history-preflight:start -->

```sql
PRAGMA defer_foreign_keys=ON;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-preflight',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_permits) AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM source_attestations a JOIN statement_submissions s ON s.id=a.statement_submission_id WHERE s.user_id<>a.user_id)
 AND NOT EXISTS(SELECT 1 FROM source_attestations a WHERE a.review_item_id IS NOT NULL AND ((NOT EXISTS(SELECT 1 FROM ingestion_review_items r WHERE r.id=a.review_item_id AND r.user_id=a.user_id) AND EXISTS(SELECT 1 FROM ingestion_review_items r WHERE r.id=a.review_item_id)) OR EXISTS(SELECT 1 FROM ingestion_review_items r WHERE r.id=a.review_item_id AND r.user_id=a.user_id AND r.transaction_id IS NOT NULL AND r.transaction_id<>a.transaction_id)))
 AND NOT EXISTS(SELECT user_id,review_item_id FROM source_attestations WHERE review_item_id IS NOT NULL GROUP BY user_id,review_item_id HAVING count(*)>1)
 AND NOT EXISTS(SELECT 1 FROM transaction_reconciliation_decisions d WHERE
   (d.state='linked' AND (SELECT count(*) FROM transactions t WHERE t.user_id=d.user_id AND t.reconciliation_first_id=d.first_transaction_id AND t.reconciliation_second_id=d.second_transaction_id AND t.deleted_at_ms IS NULL)<>2)
   OR (d.state='keep-separate' AND EXISTS(SELECT 1 FROM transactions t WHERE t.user_id=d.user_id AND t.reconciliation_first_id=d.first_transaction_id AND t.reconciliation_second_id=d.second_transaction_id)));
```

<!-- transaction-history-preflight:end -->

<!-- transaction-history-row-transactions:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row',?=1 AND EXISTS(SELECT 1 FROM transactions WHERE rowid=? AND occurred_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999 AND created_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- transaction-history-row-transactions:end -->

<!-- transaction-history-copy-transactions:start -->

```sql
INSERT INTO transactions_1462(rowid,id,user_id,amount,currency,direction,counterparty,category_id,notes,occurred_at_ms,created_at_ms,revision,user_decisions,deleted_at_ms,reconciliation_row_ref,reconciliation_first_id,reconciliation_second_id)
SELECT rowid,id,user_id,amount,currency,direction,counterparty,category_id,notes,?,?,revision,user_decisions,deleted_at_ms,reconciliation_row_ref,reconciliation_first_id,reconciliation_second_id FROM transactions WHERE rowid=? AND occurred_at IS ? AND created_at IS ?;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row-copy',changes()=1 AND EXISTS(SELECT 1 FROM transactions_1462 WHERE rowid=? AND occurred_at_ms IS ? AND created_at_ms IS ?)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- transaction-history-copy-transactions:end -->

<!-- transaction-history-copy-check-transactions:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-copy-transactions',(SELECT count(*) FROM transactions)=(SELECT count(*) FROM transactions_1462)
 AND NOT EXISTS(SELECT rowid,id,user_id,amount,currency,direction,counterparty,category_id,notes,revision,user_decisions,deleted_at_ms,reconciliation_row_ref,reconciliation_first_id,reconciliation_second_id FROM transactions
 EXCEPT SELECT rowid,id,user_id,amount,currency,direction,counterparty,category_id,notes,revision,user_decisions,deleted_at_ms,reconciliation_row_ref,reconciliation_first_id,reconciliation_second_id FROM transactions_1462);
```

<!-- transaction-history-copy-check-transactions:end -->

<!-- transaction-history-row-source_attestations:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row',?=1 AND EXISTS(SELECT 1 FROM source_attestations WHERE rowid=? AND created_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- transaction-history-row-source_attestations:end -->

<!-- transaction-history-copy-source_attestations:start -->

```sql
INSERT INTO source_attestations_1462(rowid,id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at_ms,statement_submission_id,statement_record_number,statement_content_hash,source_format,received_email_id,message_content_sha256,message_evidence,deterministic_interpretation,extractor_revision,review_item_id,user_provided_fields)
SELECT rowid,id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,?,statement_submission_id,statement_record_number,statement_content_hash,source_format,received_email_id,message_content_sha256,message_evidence,deterministic_interpretation,extractor_revision,review_item_id,user_provided_fields FROM source_attestations WHERE rowid=? AND created_at IS ?;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row-copy',changes()=1 AND EXISTS(SELECT 1 FROM source_attestations_1462 WHERE rowid=? AND created_at_ms IS ?)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- transaction-history-copy-source_attestations:end -->

<!-- transaction-history-copy-check-source_attestations:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-copy-source_attestations',(SELECT count(*) FROM source_attestations)=(SELECT count(*) FROM source_attestations_1462)
 AND NOT EXISTS(SELECT rowid,id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,statement_submission_id,statement_record_number,statement_content_hash,source_format,received_email_id,message_content_sha256,message_evidence,deterministic_interpretation,extractor_revision,review_item_id,user_provided_fields FROM source_attestations
 EXCEPT SELECT rowid,id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,statement_submission_id,statement_record_number,statement_content_hash,source_format,received_email_id,message_content_sha256,message_evidence,deterministic_interpretation,extractor_revision,review_item_id,user_provided_fields FROM source_attestations_1462);
```

<!-- transaction-history-copy-check-source_attestations:end -->

<!-- transaction-history-row-transaction_corrections:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row',?=1 AND EXISTS(SELECT 1 FROM transaction_corrections WHERE rowid=? AND corrected_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- transaction-history-row-transaction_corrections:end -->

<!-- transaction-history-copy-transaction_corrections:start -->

```sql
INSERT INTO transaction_corrections_1462(rowid,id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,corrected_at_ms)
SELECT rowid,id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,? FROM transaction_corrections WHERE rowid=? AND corrected_at IS ?;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row-copy',changes()=1 AND EXISTS(SELECT 1 FROM transaction_corrections_1462 WHERE rowid=? AND corrected_at_ms IS ?)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- transaction-history-copy-transaction_corrections:end -->

<!-- transaction-history-copy-check-transaction_corrections:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-copy-transaction_corrections',(SELECT count(*) FROM transaction_corrections)=(SELECT count(*) FROM transaction_corrections_1462)
 AND NOT EXISTS(SELECT rowid,id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts FROM transaction_corrections
 EXCEPT SELECT rowid,id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts FROM transaction_corrections_1462);
```

<!-- transaction-history-copy-check-transaction_corrections:end -->

<!-- transaction-history-row-transaction_reconciliation_decisions:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row',?=1 AND EXISTS(SELECT 1 FROM transaction_reconciliation_decisions WHERE rowid=? AND decided_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- transaction-history-row-transaction_reconciliation_decisions:end -->

<!-- transaction-history-copy-transaction_reconciliation_decisions:start -->

```sql
INSERT INTO transaction_reconciliation_decisions_1462(rowid,user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id,decided_at_ms)
SELECT rowid,user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id,? FROM transaction_reconciliation_decisions WHERE rowid=? AND decided_at IS ?;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row-copy',changes()=1 AND EXISTS(SELECT 1 FROM transaction_reconciliation_decisions_1462 WHERE rowid=? AND decided_at_ms IS ?)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- transaction-history-copy-transaction_reconciliation_decisions:end -->

<!-- transaction-history-copy-check-transaction_reconciliation_decisions:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-copy-transaction_reconciliation_decisions',(SELECT count(*) FROM transaction_reconciliation_decisions)=(SELECT count(*) FROM transaction_reconciliation_decisions_1462)
 AND NOT EXISTS(SELECT rowid,user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id FROM transaction_reconciliation_decisions
 EXCEPT SELECT rowid,user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id FROM transaction_reconciliation_decisions_1462);
```

<!-- transaction-history-copy-check-transaction_reconciliation_decisions:end -->

<!-- transaction-history-swap:start -->

```sql
DROP TABLE transactions;
DROP TABLE source_attestations;
DROP TABLE transaction_corrections;
DROP TABLE transaction_reconciliation_decisions;
ALTER TABLE transactions_1462 RENAME TO transactions;
ALTER TABLE source_attestations_1462 RENAME TO source_attestations;
ALTER TABLE transaction_corrections_1462 RENAME TO transaction_corrections;
ALTER TABLE transaction_reconciliation_decisions_1462 RENAME TO transaction_reconciliation_decisions;
```

<!-- transaction-history-swap:end -->

<!-- transaction-history-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) SELECT 'transaction-history-final',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);
DELETE FROM sql_assertions WHERE scope IN('transaction-history-preflight','transaction-history-row','transaction-history-row-copy','transaction-history-final','transaction-history-copy-transactions','transaction-history-copy-source_attestations','transaction-history-copy-transaction_corrections','transaction-history-copy-transaction_reconciliation_decisions');
PRAGMA defer_foreign_keys=OFF;
```

<!-- transaction-history-verify:end -->

## Transactions-owned financial projections (#1465)

The measured target retains the four financial read stores. Physical tables, indexes, triggers and
source view now use `transaction_projection_*` / `transaction_effective_source`. Logical erasure
store IDs remain `dashboard_projection_*`: these identify an existing purpose and archive address,
not a physical table. Owner selectors and preservation triggers emit the final numeric timestamp
fields and omit the redundant decimal maximum.

Fence financial captures/corrections/linking/deletion, repair, all projection readers and erasure.
Back up the database and capture every schema dependency. Apply #1462 first. Stop on unknown
incoming foreign keys or schema objects; compare every captured object with the checkpoint and final
baseline before generating the batch. There are no incoming foreign keys to the four projection
stores at this checkpoint. Never switch off foreign keys. The native populated conversion executes
these blocks with the final baseline declarations in one D1 batch:

1. Execute `financial-projection-preflight`. Outstanding projection archives must finish their
   existing restore/deletion lifecycle first; do not discard or reinterpret archived bodies. Active
   erasure or a selected erasure chunk also blocks conversion. Preserve unrelated completed archives.
2. For each original leaf row, decode both timestamp strings with `UtcTimestamp`, reject nonzero
   sub-millisecond precision, and bind the original rowid/strings and exact integer milliseconds to
   `financial-projection-leaf-guard`. Do the same for the nullable first-capture instant on every
   state row using `financial-projection-state-guard`; absence stays NULL. Require the original
   independently present fact-revision/first-capture/timezone group. Decode each bucket's decimal
   maximum with `Money` under its Currency and bind success to `financial-projection-money-guard`.
   Run every guard before removing any dependency. A discrepancy requires investigation.
3. Drop captured views and triggers, create the four final tables using unchanged baseline
   declarations, and copy using `financial-projection-leaf-copy`, `financial-projection-state-copy`
   (one row per guarded original), and `financial-projection-aggregate-copy`. Keep rowids and all
   independent facts, including dirty phases/cursors, versions, attempts and absent User context.
   `max_minor` keeps its historical fixed four-decimal scale; normalize the historical empty string
   for zero to canonical `0`. No Currency-specific rescaling or floating-point Money conversion.
4. Execute `financial-projection-copy-check` and `financial-projection-swap`. Reinstall the captured
   final views/triggers and replacement indexes. Unaffected indexes remain installed. Execute
   `financial-projection-verify`, then publish matching code and align the baseline ledger.

Copy/swap/interruption failures roll back the entire batch. Runtime readiness, snapshot and revision
fences remain unchanged; conversion does not repair a dirty projection or fabricate a financial
mutation. True instants become milliseconds. Bucket widths and coordinates retain the original
floor-to-seconds then truncate-by-width convention, including pre-epoch instants. Existing behavioral
coverage compares incremental deletion against rebuild across those boundaries.

<!-- financial-projection-preflight:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) SELECT 'financial-projection-cutover',
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN('dashboard_projection_state','dashboard_projection_leaf','dashboard_projection_bucket','dashboard_projection_digit'))
 AND NOT EXISTS(SELECT 1 FROM dashboard_projection_bucket WHERE
  coalesce(nullif(max_minor,''),'0')<>coalesce(nullif(ltrim(CASE WHEN instr(maximum,'.')=0 THEN maximum||'0000' ELSE replace(maximum,'.','')||substr('0000',1,4-(length(maximum)-instr(maximum,'.'))) END,'0'),''),'0'))
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- financial-projection-preflight:end -->

<!-- financial-projection-leaf-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) SELECT 'financial-projection-cutover',?=1 AND EXISTS(
 SELECT 1 FROM dashboard_projection_leaf WHERE rowid=? AND occurred_at IS ? AND created_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999 AND ? BETWEEN -62135596800000 AND 253402300799999)
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- financial-projection-leaf-guard:end -->

<!-- financial-projection-state-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) SELECT 'financial-projection-cutover',?=1 AND EXISTS(
 SELECT 1 FROM dashboard_projection_state WHERE rowid=? AND first_captured_at IS ? AND
 ((first_captured_at IS NULL AND ? IS NULL) OR (? BETWEEN -62135596800000 AND 253402300799999)))
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- financial-projection-state-guard:end -->

<!-- financial-projection-money-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) VALUES('financial-projection-cutover',?) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- financial-projection-money-guard:end -->

<!-- financial-projection-leaf-copy:start -->

```sql
INSERT INTO transaction_projection_leaf(rowid,user_id,id,amount,currency,direction,category_id,counterparty,notes,occurred_at_ms,created_at_ms,revision)
 SELECT rowid,user_id,id,amount,currency,direction,category_id,counterparty,notes,?,?,revision FROM dashboard_projection_leaf WHERE rowid=?;
INSERT INTO sql_assertions(scope,accepted) VALUES('financial-projection-cutover',changes()=1) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- financial-projection-leaf-copy:end -->

<!-- financial-projection-state-copy:start -->

```sql
INSERT INTO transaction_projection_state(rowid,user_id,version,readiness,cursor_id,attempted_at_ms,fact_revision,first_captured_at_ms,time_zone)
 SELECT rowid,user_id,version,readiness,cursor_id,attempted_at_ms,fact_revision,?,time_zone FROM dashboard_projection_state WHERE rowid=?;
INSERT INTO sql_assertions(scope,accepted) VALUES('financial-projection-cutover',changes()=1) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- financial-projection-state-copy:end -->

<!-- financial-projection-aggregate-copy:start -->

```sql
INSERT INTO transaction_projection_bucket(rowid,user_id,size_seconds,bucket,currency,direction,category_id,count,max_minor)
 SELECT rowid,user_id,size_seconds,bucket,currency,direction,category_id,count,coalesce(nullif(max_minor,''),'0') FROM dashboard_projection_bucket;
INSERT INTO transaction_projection_digit(rowid,user_id,size_seconds,bucket,currency,direction,category_id,position,digit_sum) SELECT rowid,user_id,size_seconds,bucket,currency,direction,category_id,position,digit_sum FROM dashboard_projection_digit;
```

<!-- financial-projection-aggregate-copy:end -->

<!-- financial-projection-copy-check:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) SELECT 'financial-projection-cutover',
 (SELECT count(*) FROM dashboard_projection_leaf)=(SELECT count(*) FROM transaction_projection_leaf)
 AND (SELECT count(*) FROM dashboard_projection_state)=(SELECT count(*) FROM transaction_projection_state)
 AND (SELECT count(*) FROM dashboard_projection_bucket)=(SELECT count(*) FROM transaction_projection_bucket)
 AND (SELECT count(*) FROM dashboard_projection_digit)=(SELECT count(*) FROM transaction_projection_digit)
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- financial-projection-copy-check:end -->

<!-- financial-projection-swap:start -->

```sql
DROP TABLE dashboard_projection_digit;
DROP TABLE dashboard_projection_bucket;
DROP TABLE dashboard_projection_leaf;
DROP TABLE dashboard_projection_state;
```

<!-- financial-projection-swap:end -->

<!-- financial-projection-verify:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) SELECT 'financial-projection-cutover',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='financial-projection-cutover';
```

<!-- financial-projection-verify:end -->

## Dashboard layout document verification (#1466)

No schema conversion is needed: `user_documents(user_id,kind,document_json,revision)` already is the
accepted four-column destination. Dashboard owns its bounded `DashboardDocument` codec; the shared
owner supplies authenticated same-User reads and optimistic writes for `kind='dashboard'`. Missing
layouts retain their explicit initialization behavior. No revision is copied into the layout JSON.

The existing public Dashboard initialization/edit test now creates a Planning document through its
public operation first, then verifies concurrent initialization/retries and two concurrent edits
advance the Dashboard revision without changing the Planning row, body or revision. Native
purpose-specific erasure verifies repeated Dashboard removal preserves the same User's Planning
row and the other User's layout, while a foreign erasure scope is refused. These checks extend the
existing authorization, malformed-layout, missing-layout and atomic mutation coverage. There is no
new settings table, codec, generic document endpoint or migration for this verification ticket.

## Planning document gate and accepted replacement (#1467)

The [supported-size measurement](../research/recurring-planning-storage-gate.md) found a schema-valid
100-plan/100-revision history that native D1 refuses with `SQLITE_TOOBIG`. Removing the JSON revision
does not make it fit. The original single-document conversion was halted as #1413/#1467 require.
The User subsequently accepted the following relational replacement, with no reduced product limits
or discarded history. It is implemented locally and all three review axes passed; it has not been deployed.

## #1467 approved relational Planning cutover

The User accepted the revised design from the [measured gate](../research/recurring-planning-storage-gate.md).
The shared root stores only exclusions/suggestions; its SQL revision is authoritative. Four Planning-owned
stores retain plans, effective-dated settings, exceptions and fulfillments. Each has a `position` integer
to preserve original public array order, including edited exceptions and partial fulfillments.

Pause periods stay bounded JSON; generated occurrences remain computed. Reads use one native snapshot.
Writes compare-and-swap the root before applying only changed child rows; Audit shares that atomic unit.
No unchanged historical revisions are rewritten. Static SQL batches normally use JSON arrays below 900,000 bytes; a larger individual record travels
alone with 1024 bytes reserved below D1's 2,000,000-byte row limit. Atomic batch children have a
4096-byte input bound and individual canonical admission has a 1 MiB body bound. Historical Money
exceeding the platform limit must be reported, never rounded or truncated. Domain Money itself has
no magnitude ceiling; these are platform/transport boundaries, not new financial limits.

For an existing local/remote schema: stop writers, take and verify a restorable backup, decode every
original full Planning document with `RecurringDocument` and require its JSON revision to match the row.
Refuse unexplained duplicate plan/revision/exception/fulfillment identities and missing same-User parents.
Install the four tables, ordered indexes and their triggers verbatim from `0001_schema.sql` before this batch. Never
reapply the baseline over populated state. The following copy is one native atomic batch, including guards.
It refuses active erasure or retained original Planning archives, whose old addressing must finish first.
Keep the original root rowid and Dashboard rows. Resume only with synchronized new code after native
foreign-key checks and decoded public workspace comparisons. Test interrupted/failing copies on the backup.

<!-- recurring-planning-copy:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
VALUES('recurring_plan',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id='recurring_plan_documents')
 AND NOT EXISTS(SELECT 1 FROM recurring_plans)
 AND NOT EXISTS(SELECT 1 FROM recurring_plan_revisions)
 AND NOT EXISTS(SELECT 1 FROM recurring_plan_exceptions)
 AND NOT EXISTS(SELECT 1 FROM recurring_plan_fulfillments)
 AND NOT EXISTS(SELECT 1 FROM user_documents WHERE kind='recurring-plan' AND
 (json_type(document_json,'$.revision') IS NOT 'integer' OR json_extract(document_json,'$.revision')<>revision
 OR json_type(document_json,'$.plans') IS NOT 'array' OR json_type(document_json,'$.exceptions') IS NOT 'array'
 OR json_type(document_json,'$.fulfillments') IS NOT 'array'))
 THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
INSERT INTO recurring_plans(user_id,id,position,pauses_json,stopped_on)
SELECT r.user_id,json_extract(p.value,'$.id'),CAST(p.key AS INTEGER),json_extract(p.value,'$.pauses'),json_extract(p.value,'$.stoppedOn')
FROM user_documents r,json_each(r.document_json,'$.plans') p WHERE r.kind='recurring-plan';
INSERT INTO recurring_plan_revisions(user_id,plan_id,position,from_date,plan_json)
SELECT r.user_id,json_extract(p.value,'$.id'),CAST(v.key AS INTEGER),json_extract(v.value,'$.from'),json_extract(v.value,'$.plan')
FROM user_documents r,json_each(r.document_json,'$.plans') p,json_each(p.value,'$.revisions') v WHERE r.kind='recurring-plan';
INSERT INTO recurring_plan_exceptions(user_id,plan_id,position,local_date,skipped,replacement_json)
SELECT r.user_id,json_extract(e.value,'$.planId'),CAST(e.key AS INTEGER),json_extract(e.value,'$.date'),json_extract(e.value,'$.skipped'),json_extract(e.value,'$.replacement')
FROM user_documents r,json_each(r.document_json,'$.exceptions') e WHERE r.kind='recurring-plan';
INSERT INTO recurring_plan_fulfillments(user_id,id,plan_id,position,local_date,actual_date,amount,currency,settled,automatic,transaction_id)
SELECT r.user_id,json_extract(f.value,'$.id'),json_extract(f.value,'$.planId'),CAST(f.key AS INTEGER),json_extract(f.value,'$.date'),json_extract(f.value,'$.actualDate'),json_extract(f.value,'$.money.amount'),json_extract(f.value,'$.money.currency'),json_extract(f.value,'$.settled'),json_extract(f.value,'$.automatic'),json_extract(f.value,'$.transactionId')
FROM user_documents r,json_each(r.document_json,'$.fulfillments') f WHERE r.kind='recurring-plan';
UPDATE user_documents SET document_json=json_object('excludedTransactionIds',json(json_extract(document_json,'$.excludedTransactionIds')),'suggestions',json(json_extract(document_json,'$.suggestions'))) WHERE kind='recurring-plan';
```

<!-- recurring-planning-copy:end -->

Rollback keeps writers stopped and restores the original application only after the following one-batch
reconstruction succeeds. It preserves root rowids, exact decimal text, array order and optional absence.
If new history exceeds the former single-row limit, D1 refuses reconstruction and rolls the whole batch
back, leaving new storage intact; use the verified pre-cutover backup or forward-fix instead. Never clear
child tables after failed reconstruction. Existing erasure/retention work also blocks rollback. This is
recovery evidence, not an alternate application read path.

<!-- recurring-planning-rollback:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) VALUES('recurring_plan',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN('recurring_plan_documents','recurring_plans','recurring_plan_revisions','recurring_plan_exceptions','recurring_plan_fulfillments'))
 AND NOT EXISTS(SELECT 1 FROM recurring_plans p WHERE NOT EXISTS(SELECT 1 FROM user_documents r WHERE r.user_id=p.user_id AND r.kind='recurring-plan'))
 THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
UPDATE user_documents AS r SET document_json=json_set(document_json,'$.revision',revision,
 '$.plans',json((SELECT json_group_array(json(body)) FROM (SELECT json_patch(json_object('id',p.id,'pauses',json(p.pauses_json),'revisions',json((SELECT json_group_array(json(body)) FROM (SELECT json_object('from',v.from_date,'plan',json(v.plan_json)) AS body FROM recurring_plan_revisions v WHERE v.user_id=p.user_id AND v.plan_id=p.id ORDER BY v.position)))),CASE WHEN p.stopped_on IS NULL THEN '{}' ELSE json_object('stoppedOn',p.stopped_on) END) AS body FROM recurring_plans p WHERE p.user_id=r.user_id ORDER BY p.position))),
 '$.exceptions',json((SELECT json_group_array(json(body)) FROM (SELECT json_patch(json_object('planId',e.plan_id,'date',e.local_date,'skipped',json(CASE e.skipped WHEN 1 THEN 'true' ELSE 'false' END)),CASE WHEN e.replacement_json IS NULL THEN '{}' ELSE json_object('replacement',json(e.replacement_json)) END) AS body FROM recurring_plan_exceptions e WHERE e.user_id=r.user_id ORDER BY e.position))),
 '$.fulfillments',json((SELECT json_group_array(json(body)) FROM (SELECT json_patch(json_patch(json_object('id',f.id,'planId',f.plan_id,'date',f.local_date,'actualDate',f.actual_date,'money',json_object('amount',f.amount,'currency',f.currency),'settled',json(CASE f.settled WHEN 1 THEN 'true' ELSE 'false' END)),CASE WHEN f.automatic IS NULL THEN '{}' ELSE json_object('automatic',json(CASE f.automatic WHEN 1 THEN 'true' ELSE 'false' END)) END),CASE WHEN f.transaction_id IS NULL THEN '{}' ELSE json_object('transactionId',f.transaction_id) END) AS body FROM recurring_plan_fulfillments f WHERE f.user_id=r.user_id ORDER BY f.position))))
WHERE r.kind='recurring-plan';
DELETE FROM recurring_plan_fulfillments;
DELETE FROM recurring_plan_exceptions;
DELETE FROM recurring_plan_revisions;
DELETE FROM recurring_plans;
```

<!-- recurring-planning-rollback:end -->

## Budget monthly plans and threshold cutover (#1468)

Budget creation/update and monthly threshold keys now use integer UTC milliseconds. Public instants
remain the same RFC3339 contract. A single `highest_reached` (0/80/100) replaces two flags in both
the owned domain latch and native storage; a jump to 100 still produces both original crossings.
The compact cap/plan/currency variants and their qualified keys remain unchanged. No balance,
spending counter, implicit conversion or carry-forward has been introduced.

For existing state, stop writers and take a verified backup. Snapshot the four Budget tables and
Budget work state. Validate every original timestamp through `UtcTimestamp` and reject nonzero
fractional digits beyond milliseconds; bind exact validated milliseconds below rather than using
SQLite parsing to interpret historical offsets. Validate original cap Money and crossing snapshots;
missing historical crossing JSON stays absent. Original false/true flags refuse conversion.
Refuse retained archives for the affected logical purposes until their existing lifecycle finishes.

One native batch: the guard (four original row counts), four `cutover_` tables using final definitions
from `0001_schema.sql` (child references point to `cutover_budgets`), per-row guards/copies below,
then the monthly-record copy. Drop all old indexes/triggers/views referencing any of the four tables
(including triggers attached to Transactions), drop old children before Budget, rename copied parent
then children to their final names, and reinstall the final indexes/triggers/views verbatim. These
scratch names exist only inside the atomic batch; no intermediate application release reads them.
Preserve every rowid and original Budget work/offer state; copied inserts must not generate new work.
The native fixture captures original definitions and exercises the documented blocks and whole swap.
Run `foreign_key_check` and compare decoded public caps, monthly markers, original grants/crossings,
work clocks and row identities before resuming. Failed preparation/copy/swap must leave originals intact.

<!-- budget-months-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) VALUES('budget_mutation',CASE WHEN
 (SELECT count(*) FROM budgets)=? AND (SELECT count(*) FROM budget_month_latches)=?
 AND (SELECT count(*) FROM budget_threshold_alerts)=? AND (SELECT count(*) FROM budget_month_plan_records)=?
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN('budgets','budget_month_latches','budget_threshold_alerts','budget_month_caps','budget_plan_months','budget_group_currencies'))
 THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- budget-months-guard:end -->

<!-- budget-months-budget-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) VALUES('budget_mutation',CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM budgets WHERE rowid=? AND created_at=? AND updated_at=?) THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- budget-months-budget-guard:end -->

<!-- budget-months-budget-copy:start -->

```sql
INSERT INTO cutover_budgets(rowid,id,user_id,category_id,currency,cap,created_at_ms,updated_at_ms,group_name,starts_month)
SELECT rowid,id,user_id,category_id,currency,cap,?,?,group_name,starts_month FROM budgets WHERE rowid=?;
```

<!-- budget-months-budget-copy:end -->

<!-- budget-months-budget_month_latches-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) VALUES('budget_mutation',CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM budget_month_latches WHERE rowid=? AND from_utc=?) THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- budget-months-budget_month_latches-guard:end -->

<!-- budget-months-budget_month_latches-copy:start -->

```sql
INSERT INTO cutover_budget_month_latches(rowid,user_id,budget_id,from_utc_ms,time_zone,highest_reached)
SELECT rowid,user_id,budget_id,?,time_zone,CASE WHEN reached_80=0 AND reached_100=0 THEN 0 WHEN reached_80=1 AND reached_100=0 THEN 80 WHEN reached_80=1 AND reached_100=1 THEN 100 ELSE -1 END FROM budget_month_latches WHERE rowid=?;
```

<!-- budget-months-budget_month_latches-copy:end -->

<!-- budget-months-budget_threshold_alerts-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) VALUES('budget_mutation',CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM budget_threshold_alerts WHERE rowid=? AND from_utc=?) THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- budget-months-budget_threshold_alerts-guard:end -->

<!-- budget-months-budget_threshold_alerts-copy:start -->

```sql
INSERT INTO cutover_budget_threshold_alerts(rowid,user_id,budget_id,from_utc_ms,time_zone,threshold,state,crossing_json,delivery_group_id,consent_grant_id)
SELECT rowid,user_id,budget_id,?,time_zone,threshold,state,crossing_json,delivery_group_id,consent_grant_id FROM budget_threshold_alerts WHERE rowid=?;
```

<!-- budget-months-budget_threshold_alerts-copy:end -->

<!-- budget-months-plans-copy:start -->

```sql
INSERT INTO cutover_budget_month_plan_records(rowid,kind,user_id,month,budget_id,group_name,cap,currency) SELECT rowid,kind,user_id,month,budget_id,group_name,cap,currency FROM budget_month_plan_records;
```

<!-- budget-months-plans-copy:end -->

For rollback keep writers stopped, use the same guard and row counts, create scratch tables from
the captured original definitions, run this inverse copy, swap children/parent in the same order,
and reinstall original indexes/triggers/views. Integer instants are encoded to canonical UTC;
original offset spelling may normalize but the represented millisecond and immutable crossing JSON
do not change. Restore the verified backup if either guarded reconstruction or validation refuses.

<!-- budget-months-rollback-copy:start -->

```sql
INSERT INTO cutover_budgets(rowid,id,user_id,category_id,currency,cap,created_at,updated_at,group_name,starts_month) SELECT rowid,id,user_id,category_id,currency,cap,strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch'),strftime('%Y-%m-%dT%H:%M:%fZ',updated_at_ms/1000.0,'unixepoch'),group_name,starts_month FROM budgets;
INSERT INTO cutover_budget_month_latches(rowid,user_id,budget_id,from_utc,time_zone,reached_80,reached_100) SELECT rowid,user_id,budget_id,strftime('%Y-%m-%dT%H:%M:%fZ',from_utc_ms/1000.0,'unixepoch'),time_zone,CASE WHEN highest_reached>=80 THEN 1 ELSE 0 END,CASE WHEN highest_reached=100 THEN 1 ELSE 0 END FROM budget_month_latches;
INSERT INTO cutover_budget_threshold_alerts(rowid,user_id,budget_id,from_utc,time_zone,threshold,state,crossing_json,delivery_group_id,consent_grant_id) SELECT rowid,user_id,budget_id,strftime('%Y-%m-%dT%H:%M:%fZ',from_utc_ms/1000.0,'unixepoch'),time_zone,threshold,state,crossing_json,delivery_group_id,consent_grant_id FROM budget_threshold_alerts;
INSERT INTO cutover_budget_month_plan_records(rowid,kind,user_id,month,budget_id,group_name,cap,currency) SELECT rowid,kind,user_id,month,budget_id,group_name,cap,currency FROM budget_month_plan_records;
```

<!-- budget-months-rollback-copy:end -->

## Budget work and fair User clock (#1469)

The three final stores separate one User's concurrency/first-creation facts, versioned affected
financial instants, and grouped publication evidence. One User clock replaces the three old clock
locations. Discovery still returns at most 16 Users; generation still attempts at most four per sweep.
Attempts rotate before coordinator/processing checks. Work insertion/version invalidation and a new
pending publication reset priority atomically through owner triggers. Completion clears only the
observed financial-work version; publication and first-offer completion retain their original Consent
and same-User proof guards. A completed first-offer opportunity survives deletion of the original
Budget. No workflow or delivery authority is inferred from the clock.

Stop writers and verify an independent backup before conversion. This is a synchronized baseline
cutover, not a second migration or compatibility release. Reconstruct the preceding schema from the
verbatim definitions in `apps/server/cloudflare/budgets/work-cutover.test-fixture.json`. Capture the
old row count and bind it to the guard below. Reject invalid or colliding financial instants rather
than normalizing them silently. Decode each old `occurred_at` with the original `UtcTimestamp` codec,
reject nonzero sub-millisecond digits, and bind the exact integer milliseconds to each work copy.
Every prepared work copy includes its original rowid/raw instant/version guard in the same batch.

<!-- budget-work-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'budget_work_cutover',CASE WHEN
 (SELECT count(*) FROM budget_state)=?
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN
  ('budget_user_state','budget_reconciliation_work','budget_crossing_publications'))
 AND NOT EXISTS(SELECT 1 FROM budget_state WHERE
  (kind='work' AND version<1) OR
  abs(coalesce(detected_at_ms,0))>8640000000000000 OR
  abs(coalesce(materialized_at_ms,0))>8640000000000000 OR
  abs(coalesce(created_at_ms,0))>8640000000000000 OR
  abs(coalesce(offer_requested_at_ms,0))>8640000000000000 OR
  abs(coalesce(first_last_evaluated_at_ms,0))>8640000000000000 OR
  abs(coalesce(last_evaluated_at_ms,0))>8640000000000000)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- budget-work-guard:end -->

Create scratch `cutover_budget_user_state`, `cutover_budget_evaluation_work`, and
`cutover_budget_publications` using their final table definitions, without final indexes/triggers.
Copy User facts first. Only eligible pending scopes contribute to the initial minimum clock; completed
publication/offer clocks cannot delay pending work. Absent first-creation facts stay absent. Missing
User roots required by pending work receive new helper rowids above the old state rowid range.

<!-- budget-work-roots-copy:start -->

```sql
INSERT INTO cutover_budget_user_state(rowid,user_id,revision,first_budget_id,first_created_at_ms,offer_requested_at_ms,last_evaluated_at_ms)
SELECT r.rowid,r.user_id,coalesce(r.revision,0),r.budget_id,r.created_at_ms,r.offer_requested_at_ms,
 coalesce((SELECT min(clock) FROM (
  SELECT user_id,last_evaluated_at_ms AS clock FROM budget_state WHERE kind='work'
  UNION ALL SELECT user_id,last_evaluated_at_ms FROM budget_state WHERE kind='publication' AND materialized_at_ms IS NULL
  UNION ALL SELECT user_id,first_last_evaluated_at_ms FROM budget_state WHERE kind='user' AND budget_id IS NOT NULL AND offer_requested_at_ms IS NULL
 ) p WHERE p.user_id=r.user_id),0)
FROM budget_state r WHERE r.kind='user';
INSERT INTO cutover_budget_user_state(rowid,user_id,last_evaluated_at_ms)
SELECT (SELECT coalesce(max(rowid),0) FROM budget_state)+row_number() OVER(ORDER BY user_id),user_id,min(clock)
FROM (
 SELECT user_id,last_evaluated_at_ms AS clock FROM budget_state WHERE kind='work'
 UNION ALL SELECT user_id,last_evaluated_at_ms FROM budget_state WHERE kind='publication' AND materialized_at_ms IS NULL
) p WHERE NOT EXISTS(SELECT 1 FROM cutover_budget_user_state s WHERE s.user_id=p.user_id) GROUP BY user_id;
INSERT INTO cutover_budget_publications(rowid,user_id,delivery_group_id,detected_at_ms,materialized_at_ms)
SELECT rowid,user_id,record_id,detected_at_ms,materialized_at_ms FROM budget_state WHERE kind='publication';
```

<!-- budget-work-roots-copy:end -->

<!-- budget-work-instant-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'budget_work_instant',CASE WHEN ?=1 AND EXISTS(
 SELECT 1 FROM budget_state WHERE kind='work' AND rowid=? AND occurred_at=? AND version=?)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- budget-work-instant-guard:end -->

<!-- budget-work-instant-copy:start -->

```sql
INSERT INTO cutover_budget_evaluation_work(rowid,user_id,occurred_at_ms,version)
SELECT rowid,user_id,?,version FROM budget_state WHERE kind='work' AND rowid=?;
```

<!-- budget-work-instant-copy:end -->

In that same native batch, drop all old indexes/triggers that reference `budget_state`, drop the old
table, rename the three scratch stores, and install all final indexes/triggers referencing the new
stores (including financial mutation, revision and erasure guards). A failing guard or interrupted
batch rolls back the whole copy/swap. Original source/group keys, versions, first-creation identity,
Consent, Budget/alert/Insight facts and logical erasure purposes remain intact. Old affected retained
archive bodies must be resolved before conversion; unrelated archive addresses are untouched.

For rollback, stop writers and take a new backup. Refuse active erasure or affected archives again.
Create `cutover_budget_state` from the saved old definition. Copy the following in the same batch as
the reverse object swap. This copies the shared clock into each old eligible location; historical
per-scope scheduling timestamps cannot be recovered after clock consolidation. Revision zero maps
to the former absent revision. Work instants use the canonical ISO representation of the exact
millisecond value. Helper rowids may change on rollback because separate target tables can allocate
the same rowid; logical identities and unrelated archive addresses remain unchanged.

<!-- budget-work-rollback-copy:start -->

```sql
INSERT INTO cutover_budget_state(kind,user_id,revision,budget_id,created_at_ms,offer_requested_at_ms,first_last_evaluated_at_ms,version,last_evaluated_at_ms)
SELECT 'user',user_id,nullif(revision,0),first_budget_id,first_created_at_ms,offer_requested_at_ms,
 CASE WHEN first_budget_id IS NOT NULL THEN last_evaluated_at_ms END,NULL,NULL FROM budget_user_state;
INSERT INTO cutover_budget_state(kind,user_id,occurred_at,version,last_evaluated_at_ms)
SELECT 'work',w.user_id,strftime('%Y-%m-%dT%H:%M:%fZ',w.occurred_at_ms/1000.0,'unixepoch'),w.version,s.last_evaluated_at_ms
FROM budget_evaluation_work w JOIN budget_user_state s ON s.user_id=w.user_id;
INSERT INTO cutover_budget_state(kind,user_id,record_id,detected_at_ms,materialized_at_ms,version,last_evaluated_at_ms)
SELECT 'publication',p.user_id,p.delivery_group_id,p.detected_at_ms,p.materialized_at_ms,NULL,coalesce(s.last_evaluated_at_ms,0)
FROM budget_publications p LEFT JOIN budget_user_state s ON s.user_id=p.user_id;
```

<!-- budget-work-rollback-copy:end -->

Validate rollback instants with the same original codec before swapping, guard the source counts,
and block if any instant cannot round-trip exactly through the original timestamp representation.
Drop target indexes/triggers before dropping the three tables, rename the scratch state, and reinstall
its saved related indexes/triggers. Use the backup or a forward fix when historical inconsistencies
or erasure prevent a safe conversion; never erase unexplained rows to make a conversion pass.

<!-- budget-work-rollback-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'budget_work_rollback',CASE WHEN
 (SELECT count(*) FROM budget_user_state)=? AND
 (SELECT count(*) FROM budget_evaluation_work)=? AND
 (SELECT count(*) FROM budget_publications)=? AND
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND
 NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN
 ('budget_user_state','budget_reconciliation_work','budget_crossing_publications')) AND
 NOT EXISTS(SELECT 1 FROM budget_evaluation_work w WHERE
  NOT EXISTS(SELECT 1 FROM budget_user_state s WHERE s.user_id=w.user_id) OR
  occurred_at_ms IS NOT CAST(round(unixepoch(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch'),'subsec')*1000) AS INTEGER))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- budget-work-rollback-guard:end -->

### #1471 — Recurring instants on the selected coordinator

The [measured gate](../research/recurring-detection-storage-gate.md) keeps the existing User
coordinator, bounded scratch facts/proposals and both D1 cursors. There is no new Workflow history
or expiry dependency. Phase, financial revision and page checkpoint commit together; retrying after
an unobserved commit reloads that checkpoint. A completed revision is a no-op until facts change.
The weekly changed-User interval, hourly idle discovery and four-User round-robin batch remain.

Only the physical instants change to integer UTC milliseconds. An unstarted scan uses
`cursor_at_ms=NULL,cursor_id=''`; a real cursor retains its Transaction identity. Reinitialization
preserves the preceding complete evaluation time/revision. JSON financial payloads keep their owned
codecs: the current Series, immutable first confirmation, initial reference Money and detector
support evidence have different lifetimes and are not interchangeable. Public cursor and digest
identity timestamps remain canonical ISO strings.

For a populated conversion, stop writers and snapshot the database. Save the two old definitions and
all their related indexes/triggers. Read and pin both source counts, then run the guard, create
`cutover_recurring_evaluation_records` and `cutover_recurring_series` from the final definitions,
copy, and swap both tables and related objects in **one native batch**. Preserve rowids, all JSON,
confirmation sequence, logical erasure purposes and dispatcher state. Fresh installs use only 0001.
The original writer emitted canonical ISO timestamps; noncanonical or submillisecond history is
blocked for investigation instead of silently rounded. Resolve active erasure or affected retained
archives first. Unrelated archives stay untouched.

<!-- recurring-instant-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recurring_instant_cutover',CASE WHEN
 (SELECT count(*) FROM recurring_evaluation_records)=? AND
 (SELECT count(*) FROM recurring_series)=? AND
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND
 NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN
 ('recurring_facts','recurring_progress','recurring_proposals','recurring_series','recurring_confirmations')) AND
 NOT EXISTS(SELECT 1 FROM recurring_evaluation_records WHERE
  (occurred_at IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT occurred_at) OR
  (cursor_at IS NOT NULL AND cursor_at<>'' AND strftime('%Y-%m-%dT%H:%M:%fZ',cursor_at) IS NOT cursor_at) OR
  (evaluated_at IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',evaluated_at) IS NOT evaluated_at) OR
  (first_captured_at IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',first_captured_at) IS NOT first_captured_at) OR
  (kind='progress' AND (revision<1 OR evaluated_revision<0 OR
   (cursor_at='')<>(cursor_id='') OR (evaluated_at IS NULL)<>(evaluated_revision=0) OR
   (phase='complete' AND (evaluated_revision<>revision OR evaluated_at IS NULL)))) OR
  (kind='fact' AND (json_extract(fact_json,'$.id') IS NOT id OR
   json_extract(fact_json,'$.occurredAt') IS NOT occurred_at))) AND
 NOT EXISTS(SELECT 1 FROM recurring_series WHERE
  json_extract(series_json,'$.id') IS NOT id OR json_extract(series_json,'$.money.currency') IS NOT currency OR
  (confirmed_at IS NOT NULL AND (strftime('%Y-%m-%dT%H:%M:%fZ',confirmed_at) IS NOT confirmed_at OR
   json_extract(confirmation_json,'$.id') IS NOT confirmation_id OR
   json_extract(confirmation_json,'$.seriesId') IS NOT id OR
   json_extract(confirmation_json,'$.confirmedAt') IS NOT confirmed_at OR
   json_extract(series_json,'$.confirmedAt') IS NOT confirmed_at)))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- recurring-instant-guard:end -->

Before preparing the batch, decode each retained `series_json` with the existing `RecurringSeries`
JSON codec and compute its key with Core Recurring's `normalizeCounterparty` (Unicode NFKC,
Unicode whitespace folding and lowercase). Do not replace that policy with SQLite `lower/trim`.
For every Series, include this guard in the same batch, binding its rowid, exact observed JSON and
computed normalized key. The global count check and stopped writers bind the entire preflight;
missing, undecodable, changed or mismatched rows block rather than being rewritten.

<!-- recurring-instant-series-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recurring_series_projection',CASE WHEN EXISTS(
 SELECT 1 FROM recurring_series WHERE rowid=? AND series_json=? AND counterparty_key=?
) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- recurring-instant-series-guard:end -->

<!-- recurring-instant-copy:start -->

```sql
INSERT INTO cutover_recurring_evaluation_records
(rowid,user_id,kind,id,group_key,occurred_at_ms,fact_json,proposal_json,revision,phase,cursor_at_ms,cursor_id,evaluated_at_ms,evaluated_revision,first_captured_at_ms,time_zone)
SELECT rowid,user_id,kind,id,group_key,CAST(round(unixepoch(occurred_at,'subsec')*1000) AS INTEGER),fact_json,proposal_json,revision,phase,
 CAST(round(unixepoch(nullif(cursor_at,''),'subsec')*1000) AS INTEGER),cursor_id,
 CAST(round(unixepoch(evaluated_at,'subsec')*1000) AS INTEGER),evaluated_revision,
 CAST(round(unixepoch(first_captured_at,'subsec')*1000) AS INTEGER),time_zone FROM recurring_evaluation_records;
INSERT INTO cutover_recurring_series
(rowid,user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,confirmed_at_ms,confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence)
SELECT rowid,user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,
 CAST(round(unixepoch(confirmed_at,'subsec')*1000) AS INTEGER),confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence FROM recurring_series;
```

<!-- recurring-instant-copy:end -->

For rollback stop writers and take another snapshot. Pin the current counts and use the guard below;
refuse values outside the original timestamp range or which do not round-trip exactly. Create the
two scratch tables from the saved old definitions and copy with the reverse SQL, then replace both
stores and restore their old related objects in the same batch. The initial timestamp sentinel
returns to `''`. A failing guard or failure anywhere in either copy/swap rolls back the whole batch.

<!-- recurring-instant-rollback-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recurring_instant_rollback',CASE WHEN
 (SELECT count(*) FROM recurring_evaluation_records)=? AND
 (SELECT count(*) FROM recurring_series)=? AND
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND
 NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN
 ('recurring_facts','recurring_progress','recurring_proposals','recurring_series','recurring_confirmations')) AND
 NOT EXISTS(SELECT 1 FROM (
 SELECT occurred_at_ms AS instant FROM recurring_evaluation_records UNION ALL
 SELECT cursor_at_ms FROM recurring_evaluation_records UNION ALL
 SELECT evaluated_at_ms FROM recurring_evaluation_records UNION ALL
 SELECT first_captured_at_ms FROM recurring_evaluation_records UNION ALL
 SELECT confirmed_at_ms FROM recurring_series
 ) WHERE instant IS NOT NULL AND (instant NOT BETWEEN -62135596800000 AND 253402300799999 OR
 instant IS NOT CAST(round(unixepoch(strftime('%Y-%m-%dT%H:%M:%fZ',instant/1000.0,'unixepoch'),'subsec')*1000) AS INTEGER)))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- recurring-instant-rollback-guard:end -->

<!-- recurring-instant-rollback-copy:start -->

```sql
INSERT INTO cutover_recurring_evaluation_records
(rowid,user_id,kind,id,group_key,occurred_at,fact_json,proposal_json,revision,phase,cursor_at,cursor_id,evaluated_at,evaluated_revision,first_captured_at,time_zone)
SELECT rowid,user_id,kind,id,group_key,strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch'),fact_json,proposal_json,revision,phase,
 CASE WHEN kind='progress' AND cursor_at_ms IS NULL THEN '' ELSE strftime('%Y-%m-%dT%H:%M:%fZ',cursor_at_ms/1000.0,'unixepoch') END,cursor_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',evaluated_at_ms/1000.0,'unixepoch'),evaluated_revision,
 strftime('%Y-%m-%dT%H:%M:%fZ',first_captured_at_ms/1000.0,'unixepoch'),time_zone FROM recurring_evaluation_records;
INSERT INTO cutover_recurring_series
(rowid,user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,confirmed_at,confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence)
SELECT rowid,user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',confirmed_at_ms/1000.0,'unixepoch'),confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence FROM recurring_series;
```

<!-- recurring-instant-rollback-copy:end -->

## Insights content and message ownership (#1472)

Use a single synchronized code/schema cutover under the admission fence described above. Stop
all writers first. Install the five current owner definitions under `cutover_` names, rewriting
only their mutual foreign-key targets to the scratch names. Execute preflight, copies, removal
of affected views/triggers/indexes, table swap and reinstatement of current objects in **one D1
batch**, with `PRAGMA defer_foreign_keys=ON` as its first statement. Existing Transcript and
WhatsApp tables remain in place; their incoming Event references validate at commit. Never
turn foreign keys off. A failure, including after the swap, must roll back the whole batch.

Capture source counts immediately before the fence; bind Event count and old report-envelope
count to the guard below. Before the batch, decode every retained weekly payload/presentation
and recurring report with the existing Core codecs, rejecting excess properties and malformed
Money/context/day windows. Pin each checked original JSON and its rowid in a same-batch SQL
assertion before copying; the native SQL guard additionally verifies the independent original
header/day/clock projections. Do not repair a mismatch from another copy. Block affected
retained archives or active erasure work; unrelated logical archive addresses stay untouched.
The saved preceding definitions are in `insights/content-cutover.test-fixture.json`.

The digest-only `original_delivery_expires_at_ms` preserves the historical public report expiry
when a financial report has no message. Weekly `content_expires_at_ms` remains independent of
message dispatch lifetime. Content-only history creates no fake message. Reminder grant and
its evidence deadline move to the original Event. Provider claims and unresolved sends stay in
WhatsApp storage. Offer IDs on messages are frozen evidence: consent offers may expire and be
removed while that evidence remains, so this binding deliberately has no destructive live-offer
foreign key. Current owner operations still validate the live offer before preparing delivery.

Logical erasure purposes retain their original addresses, with `insight_reports` now financial
content and `proactive_messages` its separate message purpose. Conversion blocks their affected
old archives rather than silently changing archive restoration semantics. Original receipts,
User identity, exact milliseconds and Money JSON strings must survive both directions.

<!-- insight-content-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'insight_content_cutover',CASE WHEN
 (SELECT count(*) FROM insight_events)=? AND (SELECT count(*) FROM insight_reports)=? AND
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND
 NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('insight_events','insight_delivery_attempts','insight_reports','proactive_messages','proactivity_offer_requests','weekly_question_intents','proactivity_message_events','reminder_delivery_receipts')) AND
 NOT EXISTS(SELECT 1 FROM insight_events WHERE
  strftime('%Y-%m-%dT%H:%M:%fZ',scheduled_at) IS NOT scheduled_at OR
  (delivery_sent_at IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',delivery_sent_at) IS NOT delivery_sent_at)) AND
 NOT EXISTS(SELECT 1 FROM insight_reports r LEFT JOIN insight_events e ON e.user_id=r.user_id AND e.id=r.delivery_id WHERE
  (r.kind='weekly-summary' AND (e.kind IS NOT 'weekly-summary' OR r.scheduled_at_ms IS NOT CAST(round(unixepoch(e.scheduled_at,'subsec')*1000) AS INTEGER))) OR
  (r.reminder_grant_id IS NOT NULL AND (e.kind IS NOT 'manual-entry-reminder' OR
   (r.scheduled_at_ms IS NOT NULL AND (r.consent_grant_id IS NOT r.reminder_grant_id OR r.expires_at_ms IS NOT r.reminder_expires_at_ms)))) OR
  (r.report_json IS NOT NULL AND (e.kind IS NOT 'new-recurring-series' OR
   json_extract(r.report_json,'$.insightEventId') IS NOT e.id OR
   json_extract(r.report_json,'$.serviceMarket') IS NOT e.service_market OR
   json_extract(r.report_json,'$.locale') IS NOT e.locale OR
   json_extract(r.report_json,'$.scheduledAt') IS NOT e.scheduled_at OR
   r.instruction_id IS NOT e.schedule_id OR r.instruction_version IS NOT e.schedule_version OR
   json_extract(r.report_json,'$.payload.confirmationDay.timeZone') IS NOT e.time_zone OR
   json_extract(r.report_json,'$.payload.confirmationDay.localDate') IS NOT r.local_date OR
   CAST(round(unixepoch(json_extract(r.report_json,'$.payload.confirmationDay.from'),'subsec')*1000) AS INTEGER) IS NOT r.day_from_ms OR
   CAST(round(unixepoch(json_extract(r.report_json,'$.payload.confirmationDay.toExclusive'),'subsec')*1000) AS INTEGER) IS NOT r.day_to_ms OR
   strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(r.report_json,'$.expiresAt')) IS NOT json_extract(r.report_json,'$.expiresAt') OR
   (r.scheduled_at_ms IS NOT NULL AND (r.consent_grant_id IS NOT r.grant_id OR r.scheduled_at_ms IS NOT CAST(round(unixepoch(e.scheduled_at,'subsec')*1000) AS INTEGER) OR r.expires_at_ms IS NOT CAST(round(unixepoch(json_extract(r.report_json,'$.expiresAt'),'subsec')*1000) AS INTEGER))) OR
   EXISTS(SELECT 1 FROM json_each(r.report_json) WHERE key NOT IN ('insightEventId','serviceMarket','locale','scheduledAt','expiresAt','payload')))))
 THEN 1 ELSE 0 END;
```

<!-- insight-content-guard:end -->

<!-- insight-content-json-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'insight_content_json',CASE WHEN EXISTS(SELECT 1 FROM insight_reports
 WHERE rowid=? AND payload_json IS ? AND presentation_json IS ? AND report_json IS ?)
 THEN 1 ELSE 0 END
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- insight-content-json-guard:end -->

<!-- insight-content-copy:start -->

```sql
INSERT INTO cutover_insight_events(rowid,id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at_ms,money_groups_json,lifecycle_state,delivery_receipt_id,delivery_sent_at_ms,delivery_channel,delivery_provider,delivery_provider_message_id,budget_delivery_group_id,budget_threshold,budget_crossing_json,transcript_id,transcript_kind,weekly_governor_counted,reminder_grant_id,reminder_evidence_expires_at_ms) SELECT e.rowid,e.id,e.user_id,e.kind,e.schedule_id,e.schedule_version,e.service_market,e.locale,e.time_zone,CAST(round(unixepoch(e.scheduled_at,'subsec')*1000) AS INTEGER),e.money_groups_json,e.lifecycle_state,e.delivery_receipt_id,CAST(round(unixepoch(e.delivery_sent_at,'subsec')*1000) AS INTEGER),e.delivery_channel,e.delivery_provider,e.delivery_provider_message_id,e.budget_delivery_group_id,e.budget_threshold,e.budget_crossing_json,e.transcript_id,e.transcript_kind,e.weekly_governor_counted,r.reminder_grant_id,r.reminder_expires_at_ms FROM insight_events e LEFT JOIN insight_reports r ON r.kind='proactivity-delivery' AND r.user_id=e.user_id AND r.delivery_id=e.id;

INSERT INTO cutover_insight_reports(rowid,user_id,insight_event_id,kind,consent_grant_id,payload_json,presentation_json,content_expires_at_ms,local_date,day_from_ms,day_to_ms,original_delivery_expires_at_ms) SELECT rowid,user_id,delivery_id,CASE kind WHEN 'weekly-summary' THEN 'weekly-summary' ELSE 'recurring-digest' END,CASE kind WHEN 'weekly-summary' THEN consent_grant_id ELSE grant_id END,CASE kind WHEN 'weekly-summary' THEN payload_json ELSE json_extract(report_json,'$.payload') END,presentation_json,CASE WHEN kind='weekly-summary' THEN expires_at_ms END,local_date,day_from_ms,day_to_ms,CASE WHEN report_json IS NOT NULL THEN CAST(round(unixepoch(json_extract(report_json,'$.expiresAt'),'subsec')*1000) AS INTEGER) END FROM insight_reports WHERE kind='weekly-summary' OR report_json IS NOT NULL;

INSERT INTO cutover_proactive_messages(rowid,kind,id,user_id,role,report_event_id,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted) SELECT r.rowid,r.kind,r.delivery_id,r.user_id,CASE r.kind WHEN 'weekly-summary' THEN 'weekly-summary' ELSE r.role END,CASE WHEN r.kind='weekly-summary' OR r.report_json IS NOT NULL THEN r.delivery_id END,r.consent_grant_id,r.offer_id,r.text,r.scheduled_at_ms,r.expires_at_ms,CASE r.kind WHEN 'weekly-summary' THEN e.time_zone ELSE r.time_zone END,CASE r.kind WHEN 'weekly-summary' THEN r.dispatch_created_at_ms ELSE r.created_at_ms END,r.dispatch_state,r.dispatch_created_at_ms,r.dispatch_last_attempt_at_ms,r.dispatch_restart_attempts,r.reminder_governor_counted FROM insight_reports r LEFT JOIN insight_events e ON e.user_id=r.user_id AND e.id=r.delivery_id WHERE (r.kind='weekly-summary' AND r.dispatch_state IS NOT NULL) OR (r.kind='proactivity-delivery' AND r.scheduled_at_ms IS NOT NULL);

INSERT INTO cutover_insight_offer_requests(rowid,id,user_id,request_kind,request_message_id,created_at_ms,last_evaluated_at_ms,materialized_at_ms,offer_message_id,current_recurring_opportunity) SELECT rowid,delivery_id,user_id,request_kind,request_message_id,created_at_ms,last_evaluated_at_ms,materialized_at_ms,offer_delivery_id,current_recurring_opportunity FROM insight_reports WHERE kind='offer-request';

INSERT INTO cutover_weekly_question_requests(rowid,id,user_id,origin,request_message_id,rejection_offer_id,created_at_ms,state,last_attempt_at_ms,restart_attempts) SELECT rowid,delivery_id,user_id,origin,request_message_id,rejection_offer_id,created_at_ms,dispatch_state,dispatch_last_attempt_at_ms,dispatch_restart_attempts FROM insight_reports WHERE kind='weekly-question';

UPDATE cutover_insight_events AS e SET message_kind='proactivity-delivery',message_id=(SELECT old.report_delivery_id FROM insight_events old WHERE old.user_id=e.user_id AND old.id=e.id) WHERE EXISTS(SELECT 1 FROM insight_events old WHERE old.user_id=e.user_id AND old.id=e.id AND old.report_delivery_id IS NOT NULL);

UPDATE cutover_insight_events AS e SET message_kind='weekly-summary',message_id=e.id WHERE e.kind='weekly-summary' AND EXISTS(SELECT 1 FROM cutover_proactive_messages m WHERE m.kind='weekly-summary' AND m.user_id=e.user_id AND m.id=e.id);
INSERT INTO cutover_proactive_transcript_entries(sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms) SELECT sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='proactive_transcript_entries'),0)) WHERE name='cutover_proactive_transcript_entries';
```

<!-- insight-content-copy:end -->

Rollback installs the saved two preceding owner definitions as scratch tables, with their mutual
references rewritten, then executes the guard and reconstruction below before the inverse swap.
It refuses new report/message aliases that the former one-envelope model cannot represent.
Messages still using original identities and content-only history round-trip without fabricated
work. The same admission fence, codec pinning, archive check and atomic-batch rules apply.

<!-- insight-content-rollback-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'insight_content_rollback',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND
 NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('insight_events','insight_delivery_attempts','insight_reports','proactive_messages','proactivity_offer_requests','weekly_question_intents','proactivity_message_events','reminder_delivery_receipts')) AND
 NOT EXISTS(SELECT 1 FROM proactive_messages WHERE report_event_id IS NOT NULL AND report_event_id<>id) AND
 NOT EXISTS(SELECT 1 FROM proactive_messages m JOIN insight_reports r ON r.user_id=m.user_id AND r.insight_event_id=m.report_event_id WHERE m.consent_grant_id<>r.consent_grant_id OR (r.kind='recurring-digest' AND m.expires_at_ms<>r.original_delivery_expires_at_ms) OR (r.kind='weekly-summary' AND (m.expires_at_ms<>r.content_expires_at_ms OR m.dispatch_state IS NULL))) AND
 NOT EXISTS(SELECT 1 FROM insight_events e JOIN proactive_messages m ON m.user_id=e.user_id AND m.kind=e.message_kind AND m.id=e.message_id WHERE e.kind='weekly-summary' AND (m.kind<>'weekly-summary' OR m.id<>e.id)) AND
 NOT EXISTS(SELECT 1 FROM insight_events WHERE message_kind='proactivity-delivery' AND kind='weekly-summary')
 THEN 1 ELSE 0 END;
```

<!-- insight-content-rollback-guard:end -->

<!-- insight-content-rollback-copy:start -->

```sql
INSERT INTO cutover_insight_events(rowid,id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json,lifecycle_state,delivery_receipt_id,delivery_sent_at,delivery_channel,delivery_provider,delivery_provider_message_id,budget_delivery_group_id,budget_threshold,budget_crossing_json,transcript_id,transcript_kind,weekly_governor_counted) SELECT e.rowid,e.id,e.user_id,e.kind,e.schedule_id,e.schedule_version,e.service_market,e.locale,e.time_zone,strftime('%Y-%m-%dT%H:%M:%fZ',e.scheduled_at_ms/1000.0,'unixepoch'),e.money_groups_json,e.lifecycle_state,e.delivery_receipt_id,strftime('%Y-%m-%dT%H:%M:%fZ',e.delivery_sent_at_ms/1000.0,'unixepoch'),e.delivery_channel,e.delivery_provider,e.delivery_provider_message_id,e.budget_delivery_group_id,e.budget_threshold,e.budget_crossing_json,e.transcript_id,e.transcript_kind,e.weekly_governor_counted FROM insight_events e;

INSERT INTO cutover_insight_reports(kind,user_id,delivery_id,role,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,payload_json,presentation_json,reminder_grant_id,reminder_expires_at_ms,instruction_id,instruction_version,grant_id,local_date,day_from_ms,day_to_ms,report_json,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted) SELECT CASE r.kind WHEN 'weekly-summary' THEN 'weekly-summary' ELSE 'proactivity-delivery' END,r.user_id,r.insight_event_id,CASE WHEN r.kind='recurring-digest' THEN m.role END,CASE WHEN r.kind='weekly-summary' THEN r.consent_grant_id ELSE m.consent_grant_id END,m.offer_id,m.text,CASE WHEN r.kind='weekly-summary' THEN e.scheduled_at_ms ELSE m.scheduled_at_ms END,CASE WHEN r.kind='weekly-summary' THEN r.content_expires_at_ms ELSE m.expires_at_ms END,CASE WHEN r.kind='recurring-digest' THEN m.time_zone END,CASE WHEN r.kind='recurring-digest' THEN m.created_at_ms END,CASE WHEN r.kind='weekly-summary' THEN r.payload_json END,r.presentation_json,NULL,NULL,CASE WHEN r.kind='recurring-digest' THEN e.schedule_id END,CASE WHEN r.kind='recurring-digest' THEN e.schedule_version END,CASE WHEN r.kind='recurring-digest' THEN r.consent_grant_id END,r.local_date,r.day_from_ms,r.day_to_ms,CASE WHEN r.kind='recurring-digest' THEN json_object('insightEventId',r.insight_event_id,'serviceMarket',e.service_market,'locale',e.locale,'scheduledAt',strftime('%Y-%m-%dT%H:%M:%fZ',e.scheduled_at_ms/1000.0,'unixepoch'),'expiresAt',strftime('%Y-%m-%dT%H:%M:%fZ',r.original_delivery_expires_at_ms/1000.0,'unixepoch'),'payload',json(r.payload_json)) END,m.dispatch_state,m.dispatch_created_at_ms,m.dispatch_last_attempt_at_ms,m.dispatch_restart_attempts,m.reminder_governor_counted FROM insight_reports r JOIN insight_events e ON e.user_id=r.user_id AND e.id=r.insight_event_id LEFT JOIN proactive_messages m ON m.user_id=r.user_id AND m.report_event_id=r.insight_event_id;

INSERT INTO cutover_insight_reports(kind,user_id,delivery_id,role,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,reminder_grant_id,reminder_expires_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted) SELECT m.kind,m.user_id,m.id,m.role,m.consent_grant_id,m.offer_id,m.text,m.scheduled_at_ms,m.expires_at_ms,m.time_zone,m.created_at_ms,e.reminder_grant_id,e.reminder_evidence_expires_at_ms,m.dispatch_state,m.dispatch_created_at_ms,m.dispatch_last_attempt_at_ms,m.dispatch_restart_attempts,m.reminder_governor_counted FROM proactive_messages m LEFT JOIN insight_events e ON e.user_id=m.user_id AND e.id=m.id AND e.kind='manual-entry-reminder' WHERE m.report_event_id IS NULL;

INSERT INTO cutover_insight_reports(kind,user_id,delivery_id,reminder_grant_id,reminder_expires_at_ms) SELECT 'proactivity-delivery',e.user_id,e.id,e.reminder_grant_id,e.reminder_evidence_expires_at_ms FROM insight_events e WHERE e.reminder_grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM proactive_messages m WHERE m.kind='proactivity-delivery' AND m.user_id=e.user_id AND m.id=e.id);

INSERT INTO cutover_insight_reports(kind,user_id,delivery_id,request_kind,request_message_id,created_at_ms,last_evaluated_at_ms,materialized_at_ms,offer_delivery_id,current_recurring_opportunity) SELECT 'offer-request',user_id,id,request_kind,request_message_id,created_at_ms,last_evaluated_at_ms,materialized_at_ms,offer_message_id,current_recurring_opportunity FROM insight_offer_requests;

INSERT INTO cutover_insight_reports(kind,user_id,delivery_id,origin,request_message_id,rejection_offer_id,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts) SELECT 'weekly-question',user_id,id,origin,request_message_id,rejection_offer_id,created_at_ms,state,created_at_ms,last_attempt_at_ms,restart_attempts FROM weekly_question_requests;

UPDATE cutover_insight_events AS e SET report_delivery_id=(SELECT message_id FROM insight_events old WHERE old.user_id=e.user_id AND old.id=e.id AND old.message_kind='proactivity-delivery') WHERE EXISTS(SELECT 1 FROM insight_events old WHERE old.user_id=e.user_id AND old.id=e.id AND old.message_kind='proactivity-delivery');
INSERT INTO cutover_proactive_transcript_entries(sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms) SELECT sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='proactive_transcript_entries'),0)) WHERE name='cutover_proactive_transcript_entries';
```

<!-- insight-content-rollback-copy:end -->

## Reminder reply receipts on their question (#1473)

A reminder-question message owns its optional `control_message_id` and exact `control_choice`
(command text including the question ID). Both are installed atomically with the original
Reminder governor/schedule decision after rechecking authenticated channel proof, current grant,
and the current question. Replay still requires the original message and command. The receipt is
immutable, survives text expiry, and has the existing independent `reminder_control_receipts`
erasure purpose. It adds no timestamp, TTL, message, or financial event.

Fence writers and pause erasure, then bind original control-receipt count and message count to
this guard. A receipt must map to exactly one retained same-User reminder question; no question
may have two receipts. Orphaned, malformed, conflicting or otherwise unrepresentable receipts
stop the cutover. Preserve the source and investigate; never discard exceptions or fabricate a
parent. Block affected retained archives because their receipt row references change from an
Audit sequence to the owning message. Migrated receipts retain their original sequence as
`control_audit_sequence`; their logical receipt row references and `initial:<sequence>` archive
addresses remain unchanged. New replies leave this preservation field absent and use a distinct
`message:<rowid>` receipt address. Unrelated archives retain their exact addresses.

Create the current Audit and Message table definitions as `cutover_` scratch stores, rewriting
mutual foreign-key targets only when present. Execute the guard, copy, removal of affected
non-table objects, store swap and reinstatement of current definitions in one native D1 batch,
starting with `PRAGMA defer_foreign_keys=ON`. Incoming Event links validate at commit. Save the
preceding definitions from `insights/control-cutover.test-fixture.json` for rollback. Do not turn
foreign keys off. Interruption must roll back the whole batch.

All retained Audit records keep their original sequence and values; preserve the Audit allocator
high-water mark even when its highest record moves or was deleted. Receipt identity, original sequence and
User/message/exact command survive both directions. The optional source sequence is immutable
with the receipt and is cleared only by its independent erasure purpose. It is preservation
evidence for migrated history, never a runtime counter. Rollback restores those original
sequences explicitly; only replies created after cutover allocate new Audit sequences above the
retained allocator. No receipt archive may exist during either conversion.

<!-- reminder-control-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'reminder_control_cutover',CASE WHEN
 (SELECT count(*) FROM audit_entries WHERE record_type='reminder_control')=? AND
 (SELECT count(*) FROM proactive_messages)=? AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('reminder_control_receipts','proactive_messages')) AND
 NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.record_type='reminder_control' AND
  (a.sequence<1 OR json_extract(a.id,'$[0]') IS NOT a.user_id OR json_type(a.id,'$[1]') IS NOT 'text' OR length(json_extract(a.id,'$[1]'))=0 OR
   (SELECT count(*) FROM proactive_messages m WHERE a.record_type='reminder_control' AND a.user_id=m.user_id AND m.kind='proactivity-delivery' AND m.role='reminder-question' AND a.outcome IN ('reminder:'||m.id||':continue','reminder:'||m.id||':stop'))<>1)) AND
 NOT EXISTS(SELECT 1 FROM proactive_messages m WHERE
  (SELECT count(*) FROM audit_entries a WHERE a.record_type='reminder_control' AND a.user_id=m.user_id AND m.kind='proactivity-delivery' AND m.role='reminder-question' AND a.outcome IN ('reminder:'||m.id||':continue','reminder:'||m.id||':stop'))>1)
 THEN 1 ELSE 0 END
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- reminder-control-guard:end -->

<!-- reminder-control-copy:start -->

```sql
INSERT INTO cutover_audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms) SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms FROM audit_entries WHERE record_type<>'reminder_control';

UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='audit_entries'),0)) WHERE name='cutover_audit_entries';

INSERT INTO cutover_proactive_messages(rowid,kind,id,user_id,role,report_event_id,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted,control_message_id,control_choice,control_audit_sequence)
 SELECT m.rowid,m.kind,m.id,m.user_id,m.role,m.report_event_id,m.consent_grant_id,m.offer_id,m.text,m.scheduled_at_ms,m.expires_at_ms,m.time_zone,m.created_at_ms,m.dispatch_state,m.dispatch_created_at_ms,m.dispatch_last_attempt_at_ms,m.dispatch_restart_attempts,m.reminder_governor_counted,json_extract(a.id,'$[1]'),a.outcome,a.sequence
 FROM proactive_messages m LEFT JOIN audit_entries a ON a.record_type='reminder_control' AND a.user_id=m.user_id AND m.kind='proactivity-delivery' AND m.role='reminder-question' AND a.outcome IN ('reminder:'||m.id||':continue','reminder:'||m.id||':stop');
```

<!-- reminder-control-copy:end -->

<!-- reminder-control-rollback-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted)
SELECT 'reminder_control_rollback',CASE WHEN NOT EXISTS(SELECT 1 FROM proactive_messages m JOIN audit_entries a ON a.sequence=m.control_audit_sequence) AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('reminder_control_receipts','proactive_messages')) AND
 NOT EXISTS(SELECT 1 FROM proactive_messages WHERE control_message_id IS NOT NULL AND
  (role<>'reminder-question' OR kind<>'proactivity-delivery' OR control_choice NOT IN ('reminder:'||id||':continue','reminder:'||id||':stop')))
 THEN 1 ELSE 0 END
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- reminder-control-rollback-guard:end -->

<!-- reminder-control-rollback-copy:start -->

```sql
INSERT INTO cutover_audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms) SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms FROM audit_entries;

UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='audit_entries'),0)) WHERE name='cutover_audit_entries';

INSERT INTO cutover_audit_entries(sequence,record_type,id,user_id,outcome)
 SELECT control_audit_sequence,'reminder_control',json_array(user_id,control_message_id),user_id,control_choice
 FROM proactive_messages WHERE control_audit_sequence IS NOT NULL ORDER BY control_audit_sequence;

INSERT INTO cutover_audit_entries(record_type,id,user_id,outcome)
 SELECT 'reminder_control',json_array(user_id,control_message_id),user_id,control_choice
 FROM proactive_messages WHERE control_message_id IS NOT NULL AND control_audit_sequence IS NULL ORDER BY user_id,control_message_id;

INSERT INTO cutover_proactive_messages(rowid,kind,id,user_id,role,report_event_id,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted) SELECT rowid,kind,id,user_id,role,report_event_id,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted FROM proactive_messages;
```

<!-- reminder-control-rollback-copy:end -->

## Independent weekly and reminder state (#1474)

Weekly pause/reply state now lives in `weekly_proactivity_state` (11 fields), and reminder
pause/reply state in `reminder_proactivity_state` (7 fields). Offer and question requests already
have their final stores from #1472. Receipt markers remain on the original Event or Message;
there is no second delivery counter. Reminder discovery now rotates attempted work even when the
coordinator is unavailable. Discovery remains capped at 16 Users and generation at 4 per sweep.

Proactive Transcript retains its original sequence, identity, exact text, occurrence and independent
expiry. Its generated `delivery_kind` qualifies Message links, with a same-User, kind, role and ID
foreign key. Message erasure depends on Transcript erasure as Event erasure already did. Logical
archive purpose IDs and original governor rowids remain unchanged across extraction.

Before deployment, stop writers and use the single-batch native procedure below. Save the preceding
schema from `governor-cutover.test-fixture.json`. Refuse active erasure or affected archives; do not
invent parents for orphan historical Transcript content. Bind the observed governor and Transcript
counts to the forward guard. Create scratch tables from the final definitions, rewriting references
between scratch tables. Run guard, copies, drop/recreate affected non-table objects and swap tables
in one `D1Database.batch`, starting with `PRAGMA defer_foreign_keys=ON`. No remote change is performed
by the local proof. Recheck foreign keys after the swap before admitting traffic.

Rollback uses the preceding governor/Transcript definitions and the inverse copies in one batch.
It refuses rowid collisions between independently created governor rows; no existing archive address
is silently reassigned. Resolve such a post-cutover collision explicitly before rollback. Original
migrated rows preserve their distinct rowids, and Transcript allocator high-water marks survive.
Earlier #1472 rehearsals also rebuild/copy Transcript alongside its changed parents.

<!-- insight-governor-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) SELECT 'insight_governor_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('weekly_governors','reminder_governors','proactive_transcript_entries','proactive_transcript_event_links')) AND (SELECT count(*) FROM proactivity_governors)=? AND (SELECT count(*) FROM proactive_transcript_entries)=? AND NOT EXISTS(SELECT 1 FROM proactive_transcript_entries t WHERE t.kind='message' AND NOT EXISTS(SELECT 1 FROM proactive_messages m WHERE m.user_id=t.user_id AND m.kind='proactivity-delivery' AND m.role=t.role AND m.id=t.delivery_id)) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- insight-governor-guard:end -->

<!-- insight-governor-copy:start -->

```sql
INSERT INTO cutover_weekly_proactivity_state(rowid,user_id,unanswered,last_reply_at_ms,question_needed,question_delivered,question_delivered_at_ms,question_event_id,paused_at_ms,notice_session_id,notice_turn_id,notice_completed) SELECT rowid,user_id,unanswered,last_reply_at_ms,question_needed,question_delivered,question_delivered_at_ms,question_event_id,paused_at_ms,notice_session_id,notice_turn_id,notice_completed FROM proactivity_governors WHERE kind='weekly';
INSERT INTO cutover_reminder_proactivity_state(rowid,user_id,standing_json,last_reply_at_ms,question_id,question_delivered_at_ms,notice_turn_id,notice_completed) SELECT rowid,user_id,standing_json,last_reply_at_ms,question_id,question_delivered_at_ms,notice_turn_id,notice_completed FROM proactivity_governors WHERE kind='reminder';
INSERT INTO cutover_proactive_transcript_entries(sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms) SELECT sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='proactive_transcript_entries'),0)) WHERE name='cutover_proactive_transcript_entries';

```

<!-- insight-governor-copy:end -->

<!-- insight-governor-rollback-guard:start -->

```sql
INSERT INTO sql_assertions(scope,accepted) SELECT 'insight_governor_rollback',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('weekly_governors','reminder_governors','proactive_transcript_entries','proactive_transcript_event_links')) AND NOT EXISTS(SELECT 1 FROM weekly_proactivity_state w JOIN reminder_proactivity_state r ON r.rowid=w.rowid) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
```

<!-- insight-governor-rollback-guard:end -->

<!-- insight-governor-rollback-copy:start -->

```sql
INSERT INTO cutover_proactivity_governors(rowid,kind,user_id,unanswered,last_reply_at_ms,question_needed,question_delivered,question_delivered_at_ms,question_event_id,paused_at_ms,notice_session_id,notice_turn_id,notice_completed) SELECT rowid,'weekly',user_id,unanswered,last_reply_at_ms,question_needed,question_delivered,question_delivered_at_ms,question_event_id,paused_at_ms,notice_session_id,notice_turn_id,notice_completed FROM weekly_proactivity_state;
INSERT INTO cutover_proactivity_governors(rowid,kind,user_id,standing_json,last_reply_at_ms,question_id,question_delivered_at_ms,notice_turn_id,notice_completed) SELECT rowid,'reminder',user_id,standing_json,last_reply_at_ms,question_id,question_delivered_at_ms,notice_turn_id,notice_completed FROM reminder_proactivity_state;
INSERT INTO cutover_proactive_transcript_entries(sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms) SELECT sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='proactive_transcript_entries'),0)) WHERE name='cutover_proactive_transcript_entries';

```

<!-- insight-governor-rollback-copy:end -->

## Recurring digest source scan engine gate (#1475)

The measured gate selected the existing coordinator scanner. Keep all four scan-progress columns
in the single baseline; no digest-generation Workflow or source_scan_id cutover is installed.
See [the measurement and retained behavior](../research/digest-source-workflow-1475.md). Delivery
Workflows remain independently responsible for delivery; they are not a digest source scanner.
