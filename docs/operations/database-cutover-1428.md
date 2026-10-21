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
