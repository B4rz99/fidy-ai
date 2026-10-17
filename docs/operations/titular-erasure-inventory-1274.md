# Erasure inventory for #1274

This inventory covers the current MVP schema through migration 0110. The User coordinator composes
200 owner dispositions over 201 personal-data tables. The reviewed decision selects `Delete` or a
finite, source-backed `Retain` for each class. Identity and credentials always delete; archived
records exclude credential digests, verifiers, proof material and tokens. Every disposition selects
and deletes with its own bound exact-User predicate. Billing history deliberately groups attempts
and their paid periods into one native deferred-foreign-key deletion unit.

A class hold covers all current in-scope records in the listed class; the reviewer must establish
that the cited source permits that exact breadth. A narrower source must not be expanded into a
class-wide hold. Stop review until the actual source and executable scope agree.

| Owner      | Disposition                            | Class        | D1 tables                                  |
| ---------- | -------------------------------------- | ------------ | ------------------------------------------ |
| `internal` | `oauth_access_credentials`             | credentials  | `oauth_access_credentials`                 |
| `internal` | `oauth_codes`                          | credentials  | `oauth_codes`                              |
| `internal` | `oauth_connections`                    | credentials  | `oauth_connections`                        |
| `internal` | `oauth_refresh_credentials`            | credentials  | `oauth_refresh_credentials`                |
| `internal` | `oauth_refresh_events`                 | credentials  | `oauth_refresh_events`                     |
| `internal` | `oauth_review_requests`                | credentials  | `oauth_review_requests`                    |
| `internal` | `budget_alert_occurrences`             | schedules    | `budget_alert_occurrences`                 |
| `internal` | `insight_delivery_attempts`            | schedules    | `insight_delivery_attempts`                |
| `internal` | `insight_events`                       | schedules    | `insight_events`                           |
| `internal` | `proactivity_message_events`           | schedules    | `proactivity_message_events`               |
| `internal` | `proactivity_offer_requests`           | schedules    | `proactivity_offer_requests`               |
| `internal` | `proactivity_outbox`                   | schedules    | `proactivity_outbox`                       |
| `internal` | `proactivity_reports`                  | schedules    | `proactivity_reports`                      |
| `internal` | `recurring_digest_consumption`         | schedules    | `recurring_digest_consumption`             |
| `internal` | `recurring_digest_days`                | schedules    | `recurring_digest_days`                    |
| `internal` | `recurring_digest_instructions`        | schedules    | `recurring_digest_instructions`            |
| `internal` | `recurring_digest_opportunities`       | schedules    | `recurring_digest_opportunities`           |
| `internal` | `recurring_digest_reports`             | schedules    | `recurring_digest_reports`                 |
| `internal` | `recurring_digest_scans`               | schedules    | `recurring_digest_scans`                   |
| `internal` | `recurring_digest_staging`             | schedules    | `recurring_digest_staging`                 |
| `internal` | `reminder_control_receipts`            | schedules    | `reminder_control_receipts`                |
| `internal` | `reminder_delivery_receipts`           | schedules    | `reminder_delivery_receipts`               |
| `internal` | `reminder_governors`                   | schedules    | `reminder_governors`                       |
| `internal` | `reminder_occurrence_reports`          | schedules    | `reminder_occurrence_reports`              |
| `internal` | `reminder_schedule_executions`         | schedules    | `reminder_schedule_executions`             |
| `internal` | `reminder_schedule_revisions`          | schedules    | `reminder_schedule_revisions`              |
| `internal` | `reminder_schedules`                   | schedules    | `reminder_schedules`                       |
| `internal` | `weekly_governor_deliveries`           | schedules    | `weekly_governor_deliveries`               |
| `internal` | `weekly_governors`                     | schedules    | `weekly_governors`                         |
| `internal` | `weekly_question_intents`              | schedules    | `weekly_question_intents`                  |
| `internal` | `weekly_schedule_executions`           | schedules    | `weekly_schedule_executions`               |
| `internal` | `weekly_schedule_revisions`            | schedules    | `weekly_schedule_revisions`                |
| `internal` | `weekly_schedules`                     | schedules    | `weekly_schedules`                         |
| `internal` | `weekly_summary_outbox`                | schedules    | `weekly_summary_outbox`                    |
| `internal` | `weekly_summary_reports`               | schedules    | `weekly_summary_reports`                   |
| `internal` | `browser_login_approvals`              | credentials  | `browser_login_approvals`                  |
| `internal` | `browser_login_pairings`               | credentials  | `browser_login_pairings`                   |
| `internal` | `completed_provider_authentications`   | credentials  | `completed_provider_authentications`       |
| `internal` | `provider_authentication_attempts`     | credentials  | `provider_authentication_attempts`         |
| `internal` | `provider_credentials`                 | credentials  | `provider_credentials`                     |
| `internal` | `whatsapp_provider_handoffs`           | credentials  | `whatsapp_provider_handoffs`               |
| `internal` | `email_forwarding_addresses`           | ingestion    | `email_forwarding_addresses`               |
| `internal` | `forwarded_email_deferrals`            | ingestion    | `forwarded_email_deferrals`                |
| `internal` | `forwarded_email_needs_review`         | ingestion    | `forwarded_email_needs_review`             |
| `internal` | `forwarded_email_outbox`               | ingestion    | `forwarded_email_outbox`                   |
| `internal` | `forwarded_email_outcomes`             | ingestion    | `forwarded_email_outcomes`                 |
| `internal` | `forwarded_email_receipts`             | ingestion    | `forwarded_email_receipts`                 |
| `internal` | `ingestion_review_state`               | ingestion    | `ingestion_review_state`                   |
| `internal` | `media_needs_review`                   | ingestion    | `media_needs_review`                       |
| `internal` | `media_submission_outbox`              | ingestion    | `media_submission_outbox`                  |
| `internal` | `media_submissions`                    | ingestion    | `media_submissions`                        |
| `internal` | `statement_backfill_entitlements`      | ingestion    | `statement_backfill_entitlements`          |
| `internal` | `statement_clarifications`             | ingestion    | `statement_clarifications`                 |
| `internal` | `statement_hosted_origins`             | ingestion    | `statement_hosted_origins`                 |
| `internal` | `statement_ingestion_outbox`           | ingestion    | `statement_ingestion_outbox`               |
| `internal` | `statement_materialization_parts`      | ingestion    | `statement_materialization_parts`          |
| `internal` | `statement_materializations`           | ingestion    | `statement_materializations`               |
| `internal` | `statement_needs_review`               | ingestion    | `statement_needs_review`                   |
| `internal` | `statement_record_outcomes`            | ingestion    | `statement_record_outcomes`                |
| `internal` | `statement_review_decisions`           | ingestion    | `statement_review_decisions`               |
| `internal` | `statement_staging_objects`            | ingestion    | `statement_staging_objects`                |
| `internal` | `statement_submissions`                | ingestion    | `statement_submissions`                    |
| `internal` | `statement_whatsapp_documents`         | ingestion    | `statement_whatsapp_documents`             |
| `internal` | `browser_pairing_email_outbox`         | credentials  | `browser_pairing_email_outbox`             |
| `internal` | `browser_pairing_email_proofs`         | credentials  | `browser_pairing_email_proofs`             |
| `internal` | `browser_pairing_email_user_limits`    | credentials  | `browser_pairing_email_user_limits`        |
| `internal` | `email_replacement_limits`             | credentials  | `email_replacement_limits`                 |
| `internal` | `email_replacement_outbox`             | credentials  | `email_replacement_outbox`                 |
| `internal` | `email_replacements`                   | credentials  | `email_replacements`                       |
| `internal` | `verified_email_credentials`           | credentials  | `verified_email_credentials`               |
| `internal` | `memories`                             | memory       | `memories`                                 |
| `internal` | `trial_periods`                        | identity     | `trial_periods`                            |
| `internal` | `users`                                | identity     | `users`                                    |
| `internal` | `whatsapp_identities`                  | identity     | `whatsapp_identities`                      |
| `internal` | `backup_recovery_credentials`          | credentials  | `backup_recovery_credentials`              |
| `internal` | `support_recovery_cases`               | credentials  | `support_recovery_cases`                   |
| `internal` | `support_recovery_events`              | credentials  | `support_recovery_events`                  |
| `internal` | `commercial_allowance_consumptions`    | projections  | `commercial_allowance_consumptions`        |
| `internal` | `canonical_request_acceptances`        | schedules    | `canonical_request_acceptances`            |
| `internal` | `canonical_request_buckets`            | schedules    | `canonical_request_buckets`                |
| `internal` | `canonical_request_leases`             | schedules    | `canonical_request_leases`                 |
| `internal` | `canonical_request_replays`            | schedules    | `canonical_request_replays`                |
| `internal` | `canonical_security_mutations`         | schedules    | `canonical_security_mutations`             |
| `internal` | `canonical_user_reads`                 | schedules    | `canonical_user_reads`                     |
| `internal` | `resource_admission_events`            | schedules    | `resource_admission_events`                |
| `internal` | `hosted_agent_sessions`                | conversation | `hosted_agent_sessions`                    |
| `internal` | `hosted_compacted_conversations`       | conversation | `hosted_compacted_conversations`           |
| `internal` | `hosted_compaction_attempts`           | conversation | `hosted_compaction_attempts`               |
| `internal` | `hosted_confirmations`                 | conversation | `hosted_confirmations`                     |
| `internal` | `hosted_delivery_proposals`            | conversation | `hosted_delivery_proposals`                |
| `internal` | `hosted_mutation_commits`              | conversation | `hosted_mutation_commits`                  |
| `internal` | `hosted_turn_retention`                | conversation | `hosted_turn_retention`                    |
| `internal` | `hosted_turns`                         | conversation | `hosted_turns`                             |
| `internal` | `proactive_message_transcript_entries` | conversation | `proactive_message_transcript_entries`     |
| `internal` | `proactive_transcript_entries`         | conversation | `proactive_transcript_entries`             |
| `internal` | `proactive_transcript_event_links`     | conversation | `proactive_transcript_event_links`         |
| `internal` | `transcript_entries`                   | conversation | `transcript_entries`                       |
| `internal` | `oauth_operation_intents`              | credentials  | `oauth_operation_intents`                  |
| `internal` | `billing_access_adjustments`           | billing      | `billing_access_adjustments`               |
| `internal` | `billing_checkout_responses`           | billing      | `billing_checkout_responses`               |
| `internal` | `billing_collection_arms`              | billing      | `billing_collection_arms`                  |
| `internal` | `billing_collection_outbox`            | billing      | `billing_collection_outbox`                |
| `internal` | `billing_event_candidates`             | billing      | `billing_event_candidates`                 |
| `internal` | `billing_followup_outbox`              | billing      | `billing_followup_outbox`                  |
| `internal` | `billing_no_charge_confirmations`      | billing      | `billing_no_charge_confirmations`          |
| `internal` | `billing_price_notices`                | billing      | `billing_price_notices`                    |
| `internal` | `billing_recovery_reviews`             | billing      | `billing_recovery_reviews`                 |
| `internal` | `billing_transaction_candidates`       | billing      | `billing_transaction_candidates`           |
| `internal` | `billing_transaction_evidence`         | billing      | `billing_transaction_evidence`             |
| `internal` | `card_enrollments`                     | billing      | `card_enrollments`                         |
| `internal` | `card_payment_sources`                 | billing      | `card_payment_sources`                     |
| `internal` | `payment_commit_guards`                | billing      | `payment_commit_guards`                    |
| `internal` | `refund_attempts`                      | billing      | `refund_attempts`                          |
| `internal` | `refund_outbox`                        | billing      | `refund_outbox`                            |
| `internal` | `refund_outcome_evidence`              | billing      | `refund_outcome_evidence`                  |
| `internal` | `refund_submission_claims`             | billing      | `refund_submission_claims`                 |
| `internal` | `subscription_cancellations`           | billing      | `subscription_cancellations`               |
| `internal` | `subscription_identities`              | billing      | `subscription_identities`                  |
| `internal` | `subscription_renewal_stops`           | billing      | `subscription_renewal_stops`               |
| `internal` | `subscriptions`                        | billing      | `subscriptions`                            |
| `internal` | `billing_history`                      | billing      | `billing_attempts`, `billing_paid_periods` |
| `internal` | `dashboard_documents`                  | projections  | `dashboard_documents`                      |
| `internal` | `connection_attempts`                  | projections  | `connection_attempts`                      |
| `internal` | `connection_authorization_executions`  | projections  | `connection_authorization_executions`      |
| `internal` | `connections`                          | projections  | `connections`                              |
| `internal` | `dashboard_projection_bucket`          | projections  | `dashboard_projection_bucket`              |
| `internal` | `dashboard_projection_digit`           | projections  | `dashboard_projection_digit`               |
| `internal` | `dashboard_projection_leaf`            | projections  | `dashboard_projection_leaf`                |
| `internal` | `dashboard_projection_state`           | projections  | `dashboard_projection_state`               |
| `internal` | `source_attestations`                  | transactions | `source_attestations`                      |
| `internal` | `transaction_corrections`              | transactions | `transaction_corrections`                  |
| `internal` | `transaction_fact_state`               | projections  | `transaction_fact_state`                   |
| `internal` | `transaction_reconciliation_decisions` | projections  | `transaction_reconciliation_decisions`     |
| `internal` | `transaction_reconciliation_members`   | projections  | `transaction_reconciliation_members`       |
| `internal` | `transactions`                         | transactions | `transactions`                             |
| `internal` | `consent_user_revocations`             | consent      | `consent_user_revocations`                 |
| `internal` | `oauth_grant_consents`                 | consent      | `oauth_grant_consents`                     |
| `internal` | `oauth_revocation_consents`            | consent      | `oauth_revocation_consents`                |
| `internal` | `oauth_user_revocation_consents`       | consent      | `oauth_user_revocation_consents`           |
| `internal` | `onboarding_consent_records`           | consent      | `onboarding_consent_records`               |
| `internal` | `pat_grant_consents`                   | consent      | `pat_grant_consents`                       |
| `internal` | `pat_revocation_consents`              | consent      | `pat_revocation_consents`                  |
| `internal` | `pending_consent_decisions`            | consent      | `pending_consent_decisions`                |
| `internal` | `pending_consent_delivery`             | consent      | `pending_consent_delivery`                 |
| `internal` | `pending_consent_exchanges`            | consent      | `pending_consent_exchanges`                |
| `internal` | `proactivity_consent_offers`           | consent      | `proactivity_consent_offers`               |
| `internal` | `proactivity_consent_records`          | consent      | `proactivity_consent_records`              |
| `internal` | `weekly_consent_offers`                | consent      | `weekly_consent_offers`                    |
| `internal` | `weekly_consent_records`               | consent      | `weekly_consent_records`                   |
| `internal` | `weekly_consent_rejections`            | consent      | `weekly_consent_rejections`                |
| `internal` | `weekly_consent_revocation_records`    | consent      | `weekly_consent_revocation_records`        |
| `internal` | `audit_retention_permits`              | audit        | `audit_retention_permits`                  |
| `internal` | `billing_audit`                        | audit        | `billing_audit`                            |
| `internal` | `budget_audit`                         | audit        | `budget_audit`                             |
| `internal` | `category_audit`                       | audit        | `category_audit`                           |
| `internal` | `dashboard_audit`                      | audit        | `dashboard_audit`                          |
| `internal` | `email_replacement_audit`              | audit        | `email_replacement_audit`                  |
| `internal` | `insight_audit`                        | audit        | `insight_audit`                            |
| `internal` | `media_submission_audit`               | audit        | `media_submission_audit`                   |
| `internal` | `memory_audit`                         | audit        | `memory_audit`                             |
| `internal` | `statement_clarification_audit`        | audit        | `statement_clarification_audit`            |
| `internal` | `statement_review_audit`               | audit        | `statement_review_audit`                   |
| `internal` | `statement_submission_audit`           | audit        | `statement_submission_audit`               |
| `internal` | `transaction_audit`                    | audit        | `transaction_audit`                        |
| `internal` | `web_sessions`                         | credentials  | `web_sessions`                             |
| `internal` | `budget_crossing_publications`         | projections  | `budget_crossing_publications`             |
| `internal` | `budget_first_creation`                | projections  | `budget_first_creation`                    |
| `internal` | `budget_group_currencies`              | projections  | `budget_group_currencies`                  |
| `internal` | `budget_month_caps`                    | projections  | `budget_month_caps`                        |
| `internal` | `budget_month_latches`                 | projections  | `budget_month_latches`                     |
| `internal` | `budget_plan_months`                   | projections  | `budget_plan_months`                       |
| `internal` | `budget_reconciliation_work`           | projections  | `budget_reconciliation_work`               |
| `internal` | `budget_report_progress`               | projections  | `budget_report_progress`                   |
| `internal` | `budget_threshold_alerts`              | projections  | `budget_threshold_alerts`                  |
| `internal` | `budget_user_versions`                 | projections  | `budget_user_versions`                     |
| `internal` | `budgets`                              | projections  | `budgets`                                  |
| `internal` | `keyword_rules`                        | projections  | `keyword_rules`                            |
| `internal` | `pat_audit`                            | credentials  | `pat_audit`                                |
| `internal` | `pat_pairings`                         | credentials  | `pat_pairings`                             |
| `internal` | `pat_review_attempts`                  | credentials  | `pat_review_attempts`                      |
| `internal` | `pats`                                 | credentials  | `pats`                                     |
| `internal` | `hosted_voice_refusals`                | conversation | `hosted_voice_refusals`                    |
| `internal` | `hosted_whatsapp_delivery`             | conversation | `hosted_whatsapp_delivery`                 |
| `internal` | `hosted_whatsapp_delivery_events`      | conversation | `hosted_whatsapp_delivery_events`          |
| `internal` | `hosted_whatsapp_inbound`              | conversation | `hosted_whatsapp_inbound`                  |
| `internal` | `hosted_whatsapp_outbox`               | conversation | `hosted_whatsapp_outbox`                   |
| `internal` | `hosted_whatsapp_windows`              | conversation | `hosted_whatsapp_windows`                  |
| `internal` | `insight_whatsapp_claims`              | conversation | `insight_whatsapp_claims`                  |
| `internal` | `insight_whatsapp_routes`              | conversation | `insight_whatsapp_routes`                  |
| `internal` | `proactivity_whatsapp_claims`          | conversation | `proactivity_whatsapp_claims`              |
| `internal` | `weekly_governor_questions`            | conversation | `weekly_governor_questions`                |
| `internal` | `recurring_confirmations`              | projections  | `recurring_confirmations`                  |
| `internal` | `recurring_dispatch`                   | projections  | `recurring_dispatch`                       |
| `internal` | `recurring_facts`                      | projections  | `recurring_facts`                          |
| `internal` | `recurring_legacy_confirmations`       | projections  | `recurring_legacy_confirmations`           |
| `internal` | `recurring_progress`                   | projections  | `recurring_progress`                       |
| `internal` | `recurring_proposals`                  | projections  | `recurring_proposals`                      |
| `internal` | `recurring_series`                     | projections  | `recurring_series`                         |

## Other current stores and dispositions

| Store/surface                                                                                                                                                  | Current treatment and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email original bucket                                                                                                                                          | Exact User-owned `email/v1/<UUID>` keys, forwarded review/outcome material, plus interrupted owner writer reservations. Copy only for a reviewed ingestion hold, then remove and verify source absence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Statement staging bucket                                                                                                                                       | Exact User-owned `staging/statement/v1/<digest>` keys from native staging and interrupted writer reservations; the digest is a locator, not anonymous data. The same reviewed hold/copy/source disposition applies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Private erasure bucket                                                                                                                                         | Restricted reviewed decisions, recovery locators, held originals and held D1 records. No product reader or public binding. Held copies expire with the specific reviewed class; receipts include residual R2 copies even when D1 no longer contains the archive checkpoint. Case controls have separate finite reviewed deadlines and bounded completed-case cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| User Durable Object                                                                                                                                            | Existing User coordinator; MCP owners must drain and retire, and its native alarm must be removed and read back absent before disposition. No additional financial KV/SQLite store is introduced. Platform identity/backup residuals belong in Cloudflare evidence, not an application-level physical-deletion claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Queue/Workflow/scheduled deliveries                                                                                                                            | Durable owner quiescence and native lifetime gates; only pre-cutoff admitted items may finish. Post-seal SQL fences and live conditional original writes prevent stale recreation. These platform transports are not represented as one atomic store with D1. Processor-side delivery history is separate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `anonymized_email_samples`                                                                                                                                     | Existing accepted structural-histogram policy: a fresh independent random UUID and an allowlisted HTML tag-count structure; no User/receipt link, text, attributes, addresses or amounts. Only this existing unlinked structural sample qualifies for its approved indefinite retention. See migration 0018 and the native `anonymizeStructure` owner. Ordinary linked data and pseudonyms do not inherit that policy.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `categories`, `subscription_prices`, `oauth_public_clients`, `connection_institution_gate`                                                                     | Shared catalogs/configuration, not a User's financial records or credentials. User category changes, enrollment selections, authorizations and Connections are in the owner dispositions above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `resource_admission_grants` and non-User-scoped resource events                                                                                                | Shared bounded admission/retry accounting. Exact bare-User `scope_key` events are erased by Resource Admission. A grant cannot be removed while unrelated scope events still need it; source/global events keep their original native expiry and bounded owner sweeps. They are restricted operational metadata, not declared anonymous. See `d1-admission-retention.md` and the actual AI, ingestion, provider-authentication and enrollment sweeps. Do not reset shared budgets to erase one User.                                                                                                                                                                                                                                                                                                                                                 |
| `pat_pairing_admission`, `browser_pairing_email_global_limit`                                                                                                  | Pre-User/source or singleton abuse accounting. No User attribution is added. Source digests are pseudonymous, not anonymous; their existing bounded expiry/sweeps continue. User pairing, approval, challenge and email-proof records are in the inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `support_recovery_admissions`, `support_recovery_operator_limits`                                                                                              | Operator issuer/subject admission accounting, not claimant identity evidence. Existing native one-hour cleanup remains; User cases/events/credentials are in Recovery's dispositions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `statement_review_capacity`                                                                                                                                    | Singleton aggregate pending count; ordinary native delete triggers decrement it when target review rows are erased. Contains no User key or content. Never disable its conservation rule or preserve an incorrect global count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `operational_alerts`, `operational_canary`, `operational_core_rejection_burst`, `operational_event_buckets`, `operational_health_view`, `release_smoke_probes` | Existing fixed-operation health/aggregate records, not User payload stores. Existing retention still applies. No case IDs, User IDs, financial content, raw errors or provider responses are added to observability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `audit_retention_permits`                                                                                                                                      | Existing User-specific projection is explicitly covered above; ordinary audit permissions do not become erasure authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Assertion/atomicity tables                                                                                                                                     | `budget_mutation_assertion`, `canonical_child_guard`, `canonical_request_assertions`, `category_mutation_assertion`, `commercial_allowance_assertions`, `connection_browser_atomic_assertion`, `dashboard_assertion`, `forwarded_email_assertion`, `insight_mutation_assertion`, `media_publication_assertions`, `memory_atomic_assertion`, `oauth_atomic_assertion`, `oauth_confirmation_guard`, `pat_atomic_assertion`, `proactivity_consent_assertion`, `proactivity_message_assertion`, `recurring_assertion`, `recurring_cursor_assertion`, `reminder_schedule_assertion`, `statement_submission_assertion`, `transaction_capture_assertion`, `transaction_fact_assertion`, `weekly_consent_assertion`, `weekly_schedule_assertion`: native singleton guards, not User content. Erasure runtime/writer assertion tables serve the same purpose. |
| Support mailbox, local register and evidence files                                                                                                             | Actual personal-data stores. Separate `SupportInbox`, `CaseRegister` and `CaseEvidence` custody dispositions must be evidenced through the reviewed manual procedure; the server does not pretend to erase the operator's laptop or email provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Kapso, Meta, Resend, Wompi                                                                                                                                     | Actual processor applicability and disposition must be reviewed per case. Accepted/manual requests, verified results, retained exceptions and unsupported/conflicting capability remain distinct. See the operator runbook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

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
Shared `recurring_plan_assertion` and `processing_consent_renewal_assertion` contain only a fixed
transaction assertion, no User or personal payload.
