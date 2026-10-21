# Erasure inventory for #1274

This inventory covers the current schema through migration 0162. The User coordinator composes
142 D1 owner dispositions, plus the separately published original-byte adapters. The reviewed decision selects `Delete` or a
finite, source-backed `Retain` for each class. Identity and credentials always delete; archived
records exclude credential digests, verifiers, proof material and tokens. Every disposition selects
and removes with its own bound exact-User predicate. Billing attempt archives include verified paid-period metadata. Checkout references clear under their own exact permit before provider evidence and attempt history are deleted. Budget header and dated work rows share one physical table but retain separate dispositions. Email proof erasure clears its fields without deleting a pairing belonging to another User. Report archives include dispatch progress. Stable subscription identity, forwarding address and current recurring opportunity clear only their own fields under their original logical permits. Recurring confirmation archives retain the original ID, snapshot, context, exclusion marker and sequence; their disposition clears only those fields on `recurring_series` before the series disposition deletes the parent. Transaction fact revision, first capture time and captured time zone share the Dashboard projection-state disposition, archive and dependency order; both former scopes had the same projections-class retention policy.

A class hold covers all current in-scope records in the listed class; the reviewer must establish
that the cited source permits that exact breadth. A narrower source must not be expanded into a
class-wide hold. Stop review until the actual source and executable scope agree.

| Owner                     | Disposition                             | Class        | D1 tables                                                                       |
| ------------------------- | --------------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| `recurring`               | `recurring_confirmations`               | projections  | `recurring_series` (confirmation fields)                                        |
| `recurring`               | `recurring_dispatch`                    | projections  | `recurring_dispatch`                                                            |
| `recurring`               | `recurring_facts`                       | projections  | `recurring_facts`                                                               |
| `recurring`               | `recurring_progress`                    | projections  | `recurring_progress`                                                            |
| `recurring`               | `recurring_proposals`                   | projections  | `recurring_proposals`                                                           |
| `recurring`               | `recurring_series`                      | projections  | `recurring_series`                                                              |
| `whatsapp`                | `hosted_voice_refusals`                 | conversation | `hosted_voice_refusals`                                                         |
| `whatsapp`                | `hosted_whatsapp_delivery`              | conversation | `whatsapp_deliveries`                                                           |
| `whatsapp`                | `hosted_whatsapp_delivery_events`       | conversation | `hosted_whatsapp_delivery_events`, `whatsapp_deliveries`                        |
| `whatsapp`                | `hosted_whatsapp_inbound`               | conversation | `hosted_turns (inbound fields)`                                                 |
| `whatsapp`                | `hosted_whatsapp_windows`               | conversation | `hosted_whatsapp_windows`                                                       |
| `whatsapp`                | `insight_whatsapp_claims`               | conversation | `whatsapp_deliveries`                                                           |
| `whatsapp`                | `insight_whatsapp_routes`               | conversation | `users (route fields)`                                                          |
| `whatsapp`                | `proactivity_whatsapp_claims`           | conversation | `whatsapp_deliveries`                                                           |
| `whatsapp`                | `weekly_governor_questions`             | conversation | `whatsapp_deliveries`                                                           |
| `tokens`                  | `pat_pairings`                          | credentials  | `pat_pairings`                                                                  |
| `resource-admission`      | `pat_review_attempts`                   | credentials  | `resource_admission_events` (PAT review policy), `web_sessions`                 |
| `tokens`                  | `pats`                                  | credentials  | `pats`                                                                          |
| `categories`              | `keyword_rules`                         | projections  | `keyword_rules`                                                                 |
| `budgets`                 | `budget_crossing_publications`          | projections  | `budget_crossing_publications`                                                  |
| `budgets`                 | `budget_group_currencies`               | projections  | `budget_group_currencies`                                                       |
| `budgets`                 | `budget_month_caps`                     | projections  | `budget_month_caps`                                                             |
| `budgets`                 | `budget_month_latches`                  | projections  | `budget_month_latches`                                                          |
| `budgets`                 | `budget_plan_months`                    | projections  | `budget_plan_months`                                                            |
| `budgets`                 | `budget_reconciliation_work`            | projections  | `budget_state`                                                                  |
| `budgets`                 | `budget_threshold_alerts`               | projections  | `budget_threshold_alerts`                                                       |
| `budgets`                 | `budget_user_state`                     | projections  | `budget_state`                                                                  |
| `budgets`                 | `budgets`                               | projections  | `budgets`                                                                       |
| `web-session`             | `web_sessions`                          | credentials  | `web_sessions`                                                                  |
| `audit`                   | `canonical_request_acceptances`         | schedules    | `audit_entries`                                                                 |
| `audit`                   | `canonical_user_reads`                  | schedules    | `audit_entries`                                                                 |
| `audit`                   | `canonical_security_mutations`          | schedules    | `audit_entries`                                                                 |
| `audit`                   | `session_audit`                         | audit        | `audit_entries`                                                                 |
| `audit`                   | `insight_audit`                         | audit        | `audit_entries`                                                                 |
| `audit`                   | `ingestion_publication_audit`           | audit        | `audit_entries`                                                                 |
| `audit`                   | `media_submission_audit`                | audit        | `audit_entries`                                                                 |
| `audit`                   | `billing_audit`                         | audit        | `audit_entries`, `billing_attempts`                                             |
| `audit`                   | `pat_audit`                             | credentials  | `audit_entries`                                                                 |
| `audit`                   | `audit_retention_permits`               | audit        | `audit_retention_permits`                                                       |
| `consent`                 | `processing_consent_withdrawal_records` | consent      | `consent_history`                                                               |
| `consent`                 | `processing_consent_renewals`           | consent      | `consent_history`                                                               |
| `consent`                 | `oauth_grant_consents`                  | consent      | `consent_history`                                                               |
| `consent`                 | `oauth_revocation_consents`             | consent      | `consent_history`                                                               |
| `consent`                 | `oauth_user_revocation_consents`        | consent      | `consent_history`                                                               |
| `consent`                 | `onboarding_consent_records`            | consent      | `consent_history`                                                               |
| `consent`                 | `pat_grant_consents`                    | consent      | `consent_history`                                                               |
| `consent`                 | `pat_revocation_consents`               | consent      | `consent_history`                                                               |
| `consent`                 | `proactivity_consent_records`           | consent      | `consent_history`                                                               |
| `consent`                 | `weekly_consent_records`                | consent      | `consent_history`                                                               |
| `consent`                 | `weekly_consent_rejections`             | consent      | `consent_history`                                                               |
| `consent`                 | `weekly_consent_revocation_records`     | consent      | `consent_history`                                                               |
| `consent`                 | `pending_consent_exchanges`             | consent      | `pending_consent_exchanges`, `users (WhatsApp association fields)`              |
| `consent`                 | `proactivity_consent_offers`            | consent      | `consent_offers`                                                                |
| `consent`                 | `weekly_consent_offers`                 | consent      | `consent_offers`                                                                |
| `transactions`            | `dashboard_projection_bucket`           | projections  | `dashboard_projection_bucket`                                                   |
| `transactions`            | `dashboard_projection_digit`            | projections  | `dashboard_projection_digit`                                                    |
| `transactions`            | `dashboard_projection_leaf`             | projections  | `dashboard_projection_leaf`                                                     |
| `transactions`            | `dashboard_projection_state`            | projections  | `dashboard_projection_state`                                                    |
| `transactions`            | `source_attestations`                   | transactions | `source_attestations`                                                           |
| `transactions`            | `transaction_corrections`               | transactions | `transaction_corrections`                                                       |
| `transactions`            | `transaction_reconciliation_decisions`  | projections  | `transaction_reconciliation_decisions`                                          |
| `transactions`            | `transaction_reconciliation_members`    | projections  | `transaction_reconciliation_members`                                            |
| `transactions`            | `transactions`                          | transactions | `transactions`                                                                  |
| `connections`             | `connection_attempts`                   | projections  | `connection_attempts`                                                           |
| `connections`             | `connections`                           | projections  | `connections`                                                                   |
| `dashboard`               | `dashboard_documents`                   | projections  | `user_documents (kind=dashboard)`                                               |
| `subscription`            | `billing_event_candidates`              | billing      | `billing_attempts`, `billing_event_candidates`, `billing_provider_transactions` |
| `subscription`            | `billing_price_notices`                 | billing      | `billing_price_notices`                                                         |
| `subscription`            | `billing_checkout_responses`            | billing      | `billing_attempts`                                                              |
| `subscription`            | `billing_provider_transactions`         | billing      | `billing_attempts`, `billing_provider_transactions`                             |
| `subscription`            | `card_enrollments`                      | billing      | `card_enrollments`                                                              |
| `subscription`            | `card_payment_sources`                  | billing      | `card_payment_sources`                                                          |
| `subscription`            | `refund_attempts`                       | billing      | `refund_attempts`                                                               |
| `subscription`            | `subscription_cancellations`            | billing      | `subscription_cancellations`                                                    |
| `subscription`            | `subscription_identities`               | billing      | `users` (stable subscription fields)                                            |
| `subscription`            | `subscriptions`                         | billing      | `subscriptions`                                                                 |
| `subscription`            | `billing_history`                       | billing      | `billing_attempts`                                                              |
| `oauth-confirmation`      | `oauth_operation_intents`               | credentials  | `oauth_operation_intents`                                                       |
| `agent`                   | `hosted_agent_sessions`                 | conversation | `hosted_agent_sessions`                                                         |
| `agent`                   | `hosted_compaction_attempts`            | conversation | `hosted_compaction_attempts`                                                    |
| `agent`                   | `hosted_confirmations`                  | conversation | `hosted_confirmations`                                                          |
| `agent`                   | `hosted_mutation_commits`               | conversation | `hosted_mutation_commits`                                                       |
| `agent`                   | `hosted_turns`                          | conversation | `hosted_turns`                                                                  |
| `agent`                   | `proactive_transcript_entries`          | conversation | `proactive_transcript_entries`                                                  |
| `agent`                   | `proactive_transcript_event_links`      | conversation | `proactive_transcript_event_links`                                              |
| `agent`                   | `transcript_entries`                    | conversation | `transcript_entries`                                                            |
| `resource-admission`      | `resource_admission_events`             | schedules    | `resource_admission_events`                                                     |
| `canonical-admission`     | `canonical_request_buckets`             | schedules    | `canonical_request_buckets`                                                     |
| `canonical-admission`     | `canonical_request_leases`              | schedules    | `canonical_request_leases`                                                      |
| `canonical-admission`     | `canonical_request_replays`             | schedules    | `canonical_request_replays`                                                     |
| `quotas`                  | `commercial_allowance_consumptions`     | projections  | `commercial_allowance_consumptions`                                             |
| `recovery`                | `backup_recovery_credentials`           | credentials  | `users (recovery fields)`                                                       |
| `recovery`                | `support_recovery_cases`                | credentials  | `support_recovery_cases`                                                        |
| `recovery`                | `support_recovery_events`               | credentials  | `audit_entries (support_recovery)`                                              |
| `identity`                | `users`                                 | identity     | `users`                                                                         |
| `identity`                | `whatsapp_identities`                   | identity     | `users (WhatsApp association fields)`                                           |
| `recurring-plans`         | `recurring_plan_documents`              | schedules    | `user_documents (kind=recurring-plan)`                                          |
| `memory`                  | `memories`                              | memory       | `memories`                                                                      |
| `email-authentication`    | `browser_pairing_email_proofs`          | credentials  | `browser_login_pairings`                                                        |
| `resource-admission`      | `browser_pairing_email_user_limits`     | credentials  | `resource_admission_counters`                                                   |
| `resource-admission`      | `email_replacement_limits`              | credentials  | `resource_admission_counters`                                                   |
| `email-authentication`    | `email_replacements`                    | credentials  | `email_replacements`                                                            |
| `email-authentication`    | `verified_email_credentials`            | credentials  | `users (verified email fields)`                                                 |
| `ingestion`               | `ingestion_review_state`                | ingestion    | `ingestion_review_state`                                                        |
| `ingestion`               | `email_forwarding_addresses`            | ingestion    | `users` (forwarding address fields)                                             |
| `ingestion`               | `forwarded_email_receipts`              | ingestion    | `forwarded_email_receipts`                                                      |
| `ingestion`               | `media_submissions`                     | ingestion    | `media_submissions`                                                             |
| `ingestion`               | `statement_backfill_entitlements`       | ingestion    | `users (backfill field group)`                                                  |
| `ingestion`               | `statement_materialization_parts`       | ingestion    | `statement_materialization_parts`, `statement_submissions`                      |
| `ingestion`               | `statement_needs_review`                | ingestion    | `statement_needs_review`                                                        |
| `ingestion`               | `statement_record_outcomes`             | ingestion    | `statement_record_outcomes`                                                     |
| `ingestion`               | `statement_staging_objects`             | ingestion    | `statement_staging_objects`                                                     |
| `ingestion`               | `statement_submissions`                 | ingestion    | `statement_submissions`                                                         |
| `ingestion`               | `statement_whatsapp_documents`          | ingestion    | `hosted_turns (document fields)`                                                |
| `provider-authentication` | `provider_authentication_attempts`      | credentials  | `provider_authentication_attempts`                                              |
| `provider-authentication` | `provider_credentials`                  | credentials  | `provider_credentials`                                                          |
| `provider-authentication` | `whatsapp_provider_handoffs`            | credentials  | `browser_login_pairings`, `whatsapp_provider_handoffs`                          |
| `browser-login`           | `browser_login_pairings`                | credentials  | `browser_login_pairings`                                                        |
| `insights`                | `schedule_executions`                   | schedules    | `schedule_executions`                                                           |
| `insights`                | `schedule_revisions`                    | schedules    | `schedule_revisions`                                                            |
| `insights`                | `schedules`                             | schedules    | `schedules`                                                                     |
| `insights`                | `insight_reports`                       | schedules    | `insight_reports`                                                               |
| `insights`                | `budget_alert_occurrences`              | schedules    | `insight_events (crossing fields)`                                              |
| `insights`                | `insight_delivery_attempts`             | schedules    | `insight_events (delivery receipt fields)`                                      |
| `insights`                | `insight_events`                        | schedules    | `insight_events`                                                                |
| `insights`                | `proactivity_message_events`            | schedules    | `proactivity_message_events`                                                    |
| `insights`                | `proactivity_offer_requests`            | schedules    | `proactivity_offer_requests`                                                    |
| `insights`                | `recurring_digest_consumption`          | schedules    | `recurring_digest_consumption`                                                  |
| `insights`                | `recurring_digest_days`                 | schedules    | `recurring_digest_days`                                                         |
| `insights`                | `recurring_digest_instructions`         | schedules    | `recurring_digest_instructions`                                                 |
| `insights`                | `recurring_digest_opportunities`        | schedules    | `proactivity_offer_requests` (current marker)                                   |
| `insights`                | `recurring_digest_staging`              | schedules    | `recurring_digest_staging`                                                      |
| `insights`                | `reminder_control_receipts`             | schedules    | `reminder_control_receipts`                                                     |
| `insights`                | `reminder_delivery_receipts`            | schedules    | `governor_delivery_receipts`                                                    |
| `insights`                | `reminder_governors`                    | schedules    | `proactivity_governors`                                                         |
| `insights`                | `weekly_governor_deliveries`            | schedules    | `governor_delivery_receipts`                                                    |
| `insights`                | `weekly_governors`                      | schedules    | `proactivity_governors`                                                         |
| `insights`                | `weekly_question_intents`               | schedules    | `weekly_question_intents`                                                       |
| `oauth-agents`            | `oauth_credentials`                     | credentials  | `oauth_credentials`                                                             |
| `oauth-agents`            | `oauth_connections`                     | credentials  | `oauth_connections`                                                             |
| `oauth-agents`            | `oauth_refresh_events`                  | credentials  | `audit_entries (oauth_refresh)`                                                 |
| `oauth-agents`            | `oauth_review_requests`                 | credentials  | `oauth_review_requests`                                                         |

## Other current stores and dispositions

| Store/surface                                                                                                                                                  | Current treatment and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email original bucket                                                                                                                                          | Exact User-owned `email/v1/<UUID>` keys, forwarded review/outcome material, plus interrupted owner writer reservations. Copy only for a reviewed ingestion hold, then remove and verify source absence.                                                                                                                                                                                                                                                                                              |
| Statement staging bucket                                                                                                                                       | Exact User-owned `staging/statement/v1/<digest>` keys from native staging and interrupted writer reservations; the digest is a locator, not anonymous data. The same reviewed hold/copy/source disposition applies.                                                                                                                                                                                                                                                                                  |
| Private erasure bucket                                                                                                                                         | Restricted reviewed decisions, recovery locators, held originals and held D1 records. No product reader or public binding. Held copies expire with the specific reviewed class; receipts include residual R2 copies even when D1 no longer contains the archive checkpoint. Case controls have separate finite reviewed deadlines and bounded completed-case cleanup.                                                                                                                                |
| User Durable Object                                                                                                                                            | Existing User coordinator; MCP owners must drain and retire, and its native alarm must be removed and read back absent before disposition. No additional financial KV/SQLite store is introduced. Platform identity/backup residuals belong in Cloudflare evidence, not an application-level physical-deletion claim.                                                                                                                                                                                |
| Queue/Workflow/scheduled deliveries                                                                                                                            | Durable owner quiescence and native lifetime gates; only pre-cutoff admitted items may finish. Post-seal SQL fences and live conditional original writes prevent stale recreation. These platform transports are not represented as one atomic store with D1. Processor-side delivery history is separate.                                                                                                                                                                                           |
| `anonymized_email_samples`                                                                                                                                     | Existing accepted structural-histogram policy: a fresh independent random UUID and an allowlisted HTML tag-count structure; no User/receipt link, text, attributes, addresses or amounts. Only this existing unlinked structural sample qualifies for its approved indefinite retention. See migration 0018 and the native `anonymizeStructure` owner. Ordinary linked data and pseudonyms do not inherit that policy.                                                                               |
| `categories`, `subscription_prices`, `oauth_public_clients`, `connection_institution_gate`                                                                     | Shared catalogs/configuration, not a User's financial records or credentials. User category changes, enrollment selections, authorizations and Connections are in the owner dispositions above.                                                                                                                                                                                                                                                                                                      |
| `resource_admission_grants` and non-User-scoped resource events                                                                                                | Shared bounded admission/retry accounting. Exact bare-User `scope_key` events are erased by Resource Admission. A grant cannot be removed while unrelated scope events still need it; source/global events keep their original native expiry and bounded owner sweeps. They are restricted operational metadata, not declared anonymous. See `d1-admission-retention.md` and the actual AI, ingestion, provider-authentication and enrollment sweeps. Do not reset shared budgets to erase one User. |
| `resource_admission_counters` (PAT source/global email policies)                                                                                               | Pre-User/source or singleton abuse accounting. No User attribution is added. Source digests are pseudonymous, not anonymous; their existing bounded expiry/sweeps continue. User pairing, approval, challenge and email-proof records are in the inventory.                                                                                                                                                                                                                                          |
| `support_recovery_admissions`, `support_recovery_operator_limits`                                                                                              | Operator issuer/subject admission accounting, not claimant identity evidence. Existing native one-hour cleanup remains; User cases/events/credentials are in Recovery's dispositions.                                                                                                                                                                                                                                                                                                                |
| `statement_review_capacity`                                                                                                                                    | Singleton aggregate pending count; ordinary native delete triggers decrement it when target review rows are erased. Contains no User key or content. Never disable its conservation rule or preserve an incorrect global count.                                                                                                                                                                                                                                                                      |
| `operational_alerts`, `operational_canary`, `operational_core_rejection_burst`, `operational_event_buckets`, `operational_health_view`, `release_smoke_probes` | Existing fixed-operation health/aggregate records, not User payload stores. Existing retention still applies. No case IDs, User IDs, financial content, raw errors or provider responses are added to observability.                                                                                                                                                                                                                                                                                 |
| `audit_retention_permits`                                                                                                                                      | Existing User-specific projection is explicitly covered above; ordinary audit permissions do not become erasure authority.                                                                                                                                                                                                                                                                                                                                                                           |
| Assertion/atomicity tables                                                                                                                                     | `sql_assertions` retains one fixed, metadata-only slot per assertion scope. Named request, allowance, browser-continuation, media and cursor failures are enforced in that same store. `canonical_child_guard` retains its separate composition role. These controls contain no User content.                                                                                                                                                                                                        |
| Support mailbox, local register and evidence files                                                                                                             | Actual personal-data stores. Separate `SupportInbox`, `CaseRegister` and `CaseEvidence` custody dispositions must be evidenced through the reviewed manual procedure; the server does not pretend to erase the operator's laptop or email provider.                                                                                                                                                                                                                                                  |
| Kapso, Meta, Resend, Wompi                                                                                                                                     | Actual processor applicability and disposition must be reviewed per case. Accepted/manual requests, verified results, retained exceptions and unsupported/conflicting capability remain distinct. See the operator runbook.                                                                                                                                                                                                                                                                          |

## Disabled or absent coverage

Bank-derived Connection storage exists, but direct Bancolombia/Open Banking processing has not been
enabled by this work. The actual institution gate determines applicability. An enabled Connection
with unresolved suppression blocks whole-User sealing explicitly; #313 supplies that future
bank-specific path. No new bank token/revocation API or bank erasure claim is invented here.

There is no general-purpose object export bucket, vector database, external search index or second
financial Durable Object introduced by #1274. Search/Dashboard/recurring projections actually present
in D1 are listed above. If a deployment adds a new personal-data store, its owner publication and this
inventory must be reviewed before it can participate in a completed erasure. The continuation refuses
a stored manifest that no longer matches its current owner publications.

A provider's residual backup, independent operator volume backup or linked security counter cannot
be relabelled anonymous because the normal User row was deleted. The receipt's restricted-copy,
control-retention and custodian evidence must explain actual remaining scope and its source/expiry.

## Integrated current planning and renewed Consent

The Recurring Plans owner publishes `recurring_plan_documents` as a `schedules` disposition;
its User-authored expectations are personal data, independent of historical recurring projections.
The Consent owner also disposes `processing_consent_withdrawal_records` and
`processing_consent_renewals` under `consent`, before their grant, session and User parents.
Renewal cannot restart processing after an approved erasure. Ordinary consent-history immutability
and the exact-renewal requirement remain intact outside the reviewed erasure permission.
The recurring-plan and processing-Consent renewal scopes in `sql_assertions` contain only fixed
transaction assertions, no User or personal payload.

### Consolidated physical storage (0132–0134)

Original TrialPeriod timestamps now belong to `users` and are erased under the `users` projection.
Budget reads use Transaction's complete aggregate; `budget_report_progress` has no replacement store.
The twelve consent-history projection IDs above identify logical purposes in one physical
`consent_history` table. They retain independent archive policies, dependency ordering and exact
permits; their old table names are no longer physical stores. The shared record-type filter must
remain in every selection and removal. Current consent standing and pending offers remain separate.

### Attempts, ingestion companions, offers, governors and channel delivery (0138–0143)

Connection preparation and completed provider authentication now belong to their attempt rows.
Statement submissions own the materialization manifest, hosted-origin binding and clarification
state; bounded materialization parts remain separate. Forwarded email receipts own their immutable
review metadata and completion outcome. The parent dispositions archive these fields and delete
in the revised foreign-key order; credentials still never enter retained archives.

`consent_offers` shares storage for weekly and contextual offers, with typed offer references in
`consent_history`. `proactivity_governors` and `governor_delivery_receipts` qualify every User identity
by governor kind. `whatsapp_deliveries` holds hosted replies, summary sends, contextual sends and
weekly questions. Existing logical disposition IDs remain distinct in these shared tables so each
purpose keeps its exact permit, archive fields, retention boundary and dependencies. Selection and
removal always constrain both kind and User. Hosted callback events retain a foreign key that only
a hosted delivery can satisfy; consolidation cannot make an ambiguous send eligible for retry.

Migrations 0156–0158 reduce the physical schema to 139 tables while retaining 142 D1 logical
purposes. Delivery receipts clear only their InsightEvent field group. Statement backfill clears
only the User entitlement group before submission deletion. The two document purposes filter their
own `user_documents.kind`; their original data classes and archive shapes remain distinct. All three
folds retain same-User, purpose-specific, chunk-bounded deletion authority.

Migrations 0159–0162 reduce the physical schema further to 130 tables, retaining the same 142 D1
logical purposes. Credential and route groups clear independently on User; WhatsApp inbound and
statement attachments clear independently on hosted Turn. OAuth and support records qualify their
Audit kind. Budget crossing evidence clears independently on InsightEvent. Hosted delivery foreign
keys require an inbound-qualified Turn; staging cleanup never deletes the Turn.
