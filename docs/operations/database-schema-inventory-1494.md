# Schema integration inventory (#1494)

Local fresh-install snapshot of [the single baseline](../../apps/server/cloudflare/migrations/0001_schema.sql).
Schema Git blob: `97c1d2d7556af70670a8f0f84f3ecea7369116a2`. This is not a live database inspection or a completed release.

The baseline creates **113 application tables**. The original 102-name inventory predates the
approved four-table relational Planning replacement and the retained compact Recovery admission
exception, plus the approved retained upload-writer safeguard. Including those outcomes gives **108 target tables**. Five additional stores remain
behind explicit Erasure and Operational Health gates; their presence is intentional until the
replacement is proven. The four Transaction projections remain after the direct-read benchmark
failed its cost gate. Counts describe these decisions; they are not test assertions or success criteria.

## Outstanding decisions and evidence

| Area                 | Current outcome                                                                                                        | Reference                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Planning             | Shared root plus four ordered relational stores; the full aggregate exceeded the native row limit                      | [#1467](https://github.com/B4rz99/fidy-ai/issues/1467), [size evidence](../research/recurring-planning-storage-gate.md)      |
| Recovery admission   | Retain compact specialized accounting; generic conversion failed the accepted cost gate                                | [#1434](https://github.com/B4rz99/fidy-ai/issues/1434), [comparison](recovery-admission-1434.md)                             |
| Erasure              | Retain unresolved writers in the approved seven-table target; archives and object inventory await #1489                | [#1487](https://github.com/B4rz99/fidy-ai/issues/1487), [cutover gate](database-cutover-1428.md#confirmed-upload-drain-1487) |
| Operational Health   | Retain alert/event/health stores until platform query coverage and actual notification/dashboard behavior are verified | [#1491](https://github.com/B4rz99/fidy-ai/issues/1491), [#1492](https://github.com/B4rz99/fidy-ai/issues/1492)               |
| Release verification | Native release-owned execution replaces the synthetic D1 ledger locally; remote rollout remains separate evidence      | [#1493](https://github.com/B4rz99/fidy-ai/issues/1493)                                                                       |

## Physical ownership and declared relationships

Every row names one persistence owner. Consumers use its published interface; a foreign key does
not grant cross-owner SQL authority. `stored + generated` distinguishes physical values from
computed helpers. References group composite keys together. A dash means no declared foreign key,
not absence of logical dependencies. Implicit SQLite rowids are not counted as declared columns.
Views, indexes and provider-managed storage are excluded.

### Identity (`identity`)

| Table   | Stored + generated columns | Foreign keys |
| ------- | -------------------------- | ------------ |
| `users` | 10 + 0                     | —            |

### Subscription (`subscription`)

| Table                           | Stored + generated columns | Foreign keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `billing_attempts`              | 29 + 1                     | `(previous_paid_attempt_id,subscription_id) → billing_attempts(paid_attempt_id,subscription_id)`; `(previous_paid_attempt_id) → billing_attempts(paid_attempt_id)`; `(checkout_transaction_id) → billing_provider_transactions(transaction_id)`; `(enrollment_id,subscription_id) → payment_enrollments(id,subscription_id)`; `(enrollment_id) → payment_enrollments(id)`; `(payment_source_id,subscription_id) → payment_sources(id,subscription_id)`; `(payment_source_id) → payment_sources(id)`; `(price_id) → subscription_prices(id)`; `(subscription_id) → subscriptions(id)` |
| `billing_price_notices`         | 6 + 0                      | `(price_id) → subscription_prices(id)`; `(subscription_id) → subscriptions(id)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `billing_provider_transactions` | 15 + 1                     | `(attempt_id) → billing_attempts(id)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `payment_enrollments`           | 20 + 0                     | `(payment_source_id,subscription_id) → payment_sources(id,subscription_id)`; `(price_id) → subscription_prices(id)`; `(subscription_id) → subscriptions(id)`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `payment_sources`               | 10 + 0                     | `(origin_enrollment_id,subscription_id) → payment_enrollments(id,subscription_id)`; `(subscription_id) → subscriptions(id)`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `refund_attempts`               | 24 + 1                     | `(billing_attempt_id) → billing_attempts(id)`; `(transaction_id) → billing_provider_transactions(evidence_transaction_id)`; `(user_id) → users(id)`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `subscription_cancellations`    | 10 + 0                     | `(paid_attempt_id,subscription_id) → billing_attempts(paid_attempt_id,subscription_id)`; `(payment_source_id,subscription_id) → payment_sources(id,subscription_id)`; `(subscription_id) → subscriptions(id)`                                                                                                                                                                                                                                                                                                                                                                        |
| `subscription_prices`           | 8 + 0                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `subscriptions`                 | 3 + 0                      | `(current_paid_attempt_id,id) → billing_attempts(paid_attempt_id,subscription_id)`; `(user_id) → users(id)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Ingestion (`ingestion`)

| Table                             | Stored + generated columns | Foreign keys                                                                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anonymized_email_samples`        | 9 + 0                      | —                                                                                                                                                                                                                                                                                             |
| `forwarded_email_receipts`        | 16 + 0                     | `(outcome_transaction_id) → transactions(id)`; `(user_id) → users(id)`                                                                                                                                                                                                                        |
| `forwarding_addresses`            | 4 + 0                      | `(user_id) → users(id)`                                                                                                                                                                                                                                                                       |
| `ingestion_review_items`          | 27 + 0                     | `(user_id,email_receipt_id) → forwarded_email_receipts(user_id,id)`; `(user_id,media_submission_id) → media_submissions(user_id,id)`; `(user_id,statement_submission_id) → statement_submissions(user_id,id)`; `(transaction_id,user_id) → transactions(id,user_id)`; `(user_id) → users(id)` |
| `media_submissions`               | 14 + 0                     | `(user_id) → users(id)`                                                                                                                                                                                                                                                                       |
| `statement_backfill_entitlements` | 3 + 0                      | `(user_id,submission_id) → statement_submissions(user_id,id)`; `(user_id) → users(id)`                                                                                                                                                                                                        |
| `statement_materialization_parts` | 5 + 0                      | `(submission_id) → statement_materializations(submission_id)`                                                                                                                                                                                                                                 |
| `statement_materializations`      | 10 + 0                     | `(submission_id) → statement_submissions(id)`                                                                                                                                                                                                                                                 |
| `statement_record_outcomes`       | 5 + 0                      | `(user_id,submission_id) → statement_submissions(user_id,id)`; `(user_id,transaction_id) → transactions(user_id,id)`                                                                                                                                                                          |
| `statement_review_capacity`       | 2 + 0                      | —                                                                                                                                                                                                                                                                                             |
| `statement_staging_objects`       | 11 + 0                     | `(user_id) → users(id)`                                                                                                                                                                                                                                                                       |
| `statement_submissions`           | 29 + 0                     | `(staging_id) → statement_staging_objects(id)`; `(user_id) → users(id)`                                                                                                                                                                                                                       |

### Insights (`insights`)

| Table                          | Stored + generated columns | Foreign keys                                                                                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `insight_events`               | 26 + 1                     | `(user_id,reminder_history_type,reminder_grant_id) → consent_history(user_id,record_type,id)`; `(user_id,message_kind,kind,message_id) → proactive_messages(user_id,kind,role,id)`; `(user_id,transcript_kind,transcript_id) → proactive_transcript_entries(user_id,kind,id)`; `(user_id) → users(id)` |
| `insight_offer_requests`       | 9 + 2                      | `(user_id,message_kind,message_role,offer_message_id) → proactive_messages(user_id,kind,role,id)`; `(user_id) → users(id)`                                                                                                                                                                             |
| `insight_reports`              | 11 + 2                     | `(user_id,grant_history_type,consent_grant_id) → consent_history(user_id,record_type,id)`; `(user_id,event_kind,insight_event_id) → insight_events(user_id,kind,id)`; `(user_id) → users(id)`                                                                                                          |
| `proactive_messages`           | 20 + 2                     | `(user_id,grant_history_type,consent_grant_id) → consent_history(user_id,record_type,id)`; `(user_id,report_kind,report_event_id,consent_grant_id) → insight_reports(user_id,kind,insight_event_id,consent_grant_id)`; `(user_id) → users(id)`                                                         |
| `proactive_transcript_entries` | 10 + 1                     | `(user_id,insight_event_id) → insight_events(user_id,id)`; `(user_id,delivery_kind,role,delivery_id) → proactive_messages(user_id,kind,role,id)`; `(user_id) → users(id)`                                                                                                                              |
| `recurring_digest_items`       | 7 + 0                      | `(user_id) → users(id)`                                                                                                                                                                                                                                                                                |
| `reminder_proactivity_state`   | 7 + 0                      | `(user_id) → users(id)`                                                                                                                                                                                                                                                                                |
| `schedule_history`             | 12 + 0                     | `(user_id,kind,schedule_id) → schedules(user_id,kind,id)`; `(user_id) → users(id)`                                                                                                                                                                                                                     |
| `schedules`                    | 17 + 1                     | `(user_id,proactivity_grant_type,consent_grant_id) → consent_history(user_id,record_type,id)`; `(user_id) → users(id)`                                                                                                                                                                                 |
| `weekly_proactivity_state`     | 11 + 0                     | `(user_id) → users(id)`                                                                                                                                                                                                                                                                                |
| `weekly_question_requests`     | 9 + 0                      | `(user_id) → users(id)`                                                                                                                                                                                                                                                                                |

### Audit (`audit`)

| Table                     | Stored + generated columns | Foreign keys                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `audit_entries`           | 14 + 2                     | `(attempt_id) → billing_attempts(id)`; `(hosted_turn_id) → hosted_turns(id)`; `(media_submission_id) → media_submissions(id)`; `(oauth_connection_id) → oauth_connections(id)`; `(oauth_credential_id) → oauth_credentials(access_id)`; `(pat_id) → pats(id)`; `(user_id) → users(id)`; `(credential_session_id) → web_sessions(id)` |
| `audit_retention_permits` | 2 + 0                      | `(user_id) → users(id)`                                                                                                                                                                                                                                                                                                              |

### OAuth Agents (`oauth-agents`)

| Table                   | Stored + generated columns | Foreign keys                                                                                                                                                               |
| ----------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth_connections`     | 16 + 0                     | `(user_id) → users(id)`                                                                                                                                                    |
| `oauth_credentials`     | 12 + 2                     | `(connection_id) → oauth_connections(id)`; `(user_id,connection_id,replacement_refresh_id) → oauth_credentials(user_id,connection_id,refresh_id)`; `(user_id) → users(id)` |
| `oauth_public_clients`  | 4 + 0                      | —                                                                                                                                                                          |
| `oauth_review_requests` | 8 + 0                      | `(client_id) → oauth_public_clients(id)`                                                                                                                                   |

### OAuth Confirmation (`oauth-confirmation`)

| Table                     | Stored + generated columns | Foreign keys                                                                                                  |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `oauth_operation_intents` | 12 + 0                     | `(connection_id) → oauth_connections(id)`; `(user_id) → users(id)`; `(browser_session_id) → web_sessions(id)` |

### Browser Login (`browser-login`)

| Table                    | Stored + generated columns | Foreign keys                                                                             |
| ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------- |
| `browser_login_pairings` | 26 + 0                     | `(email_user_id) → users(id)`; `(approval_user_id) → users(id)`; `(user_id) → users(id)` |

### WebSession (`web-session`)

| Table          | Stored + generated columns | Foreign keys                                                         |
| -------------- | -------------------------- | -------------------------------------------------------------------- |
| `web_sessions` | 9 + 0                      | `(pairing_id) → browser_login_pairings(id)`; `(user_id) → users(id)` |

### Email Authentication (`email-authentication`)

| Table                        | Stored + generated columns | Foreign keys                                               |
| ---------------------------- | -------------------------- | ---------------------------------------------------------- |
| `email_replacements`         | 14 + 0                     | `(user_id) → users(id)`; `(session_id) → web_sessions(id)` |
| `verified_email_credentials` | 3 + 0                      | `(user_id) → users(id)`                                    |

### Provider Authentication (`provider-authentication`)

| Table                              | Stored + generated columns | Foreign keys                                                                                                          |
| ---------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `provider_authentication_attempts` | 18 + 0                     | `(pairing_id) → browser_login_pairings(id)`; `(user_id) → users(id)`; `(handoff_id) → whatsapp_provider_handoffs(id)` |
| `provider_credentials`             | 5 + 0                      | `(user_id) → users(id)`                                                                                               |
| `whatsapp_provider_handoffs`       | 13 + 0                     | `(pairing_id) → browser_login_pairings(id)`; `(exchange_id) → pending_consent_exchanges(id)`                          |

### Recovery (`recovery`)

| Table                         | Stored + generated columns | Foreign keys                                                         |
| ----------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `backup_recovery_credentials` | 5 + 0                      | `(user_id) → users(id)`                                              |
| `support_recovery_admissions` | 4 + 0                      | —                                                                    |
| `support_recovery_cases`      | 14 + 0                     | `(pairing_id) → browser_login_pairings(id)`; `(user_id) → users(id)` |

### Resource Admission (`resource-admission`)

| Table                         | Stored + generated columns | Foreign keys                                                                                                         |
| ----------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `resource_admission_counters` | 8 + 0                      | `(owner_user_id) → users(id)`                                                                                        |
| `resource_admission_events`   | 12 + 0                     | `(grant_id) → resource_admission_grants(id)`; `(owner_user_id) → users(id)`; `(owner_session_id) → web_sessions(id)` |
| `resource_admission_grants`   | 3 + 0                      | —                                                                                                                    |

### Canonical Admission (`canonical-admission`)

| Table                       | Stored + generated columns | Foreign keys            |
| --------------------------- | -------------------------- | ----------------------- |
| `canonical_request_buckets` | 2 + 0                      | —                       |
| `canonical_request_leases`  | 3 + 0                      | `(user_id) → users(id)` |
| `canonical_request_replays` | 10 + 0                     | `(user_id) → users(id)` |

### Quotas (`quotas`)

| Table                               | Stored + generated columns | Foreign keys            |
| ----------------------------------- | -------------------------- | ----------------------- |
| `commercial_allowance_consumptions` | 6 + 0                      | `(user_id) → users(id)` |

### Tokens (`tokens`)

| Table          | Stored + generated columns | Foreign keys                                               |
| -------------- | -------------------------- | ---------------------------------------------------------- |
| `pat_pairings` | 15 + 0                     | `(user_id) → users(id)`                                    |
| `pats`         | 14 + 0                     | `(pairing_id) → pat_pairings(id)`; `(user_id) → users(id)` |

### Transactions (`transactions`)

| Table                                  | Stored + generated columns | Foreign keys                                                                                                                                                                                                       |
| -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source_attestations`                  | 20 + 0                     | `(user_id,received_email_id) → forwarded_email_receipts(user_id,id)`; `(user_id,statement_submission_id) → statement_submissions(user_id,id)`; `(user_id,transaction_id) → transactions(user_id,id)`               |
| `transaction_corrections`              | 8 + 0                      | `(user_id,transaction_id) → transactions(user_id,id)`                                                                                                                                                              |
| `transaction_projection_bucket`        | 8 + 0                      | `(category_id) → categories(id)`; `(user_id) → users(id)`                                                                                                                                                          |
| `transaction_projection_digit`         | 8 + 0                      | `(category_id) → categories(id)`; `(user_id) → users(id)`                                                                                                                                                          |
| `transaction_projection_leaf`          | 11 + 0                     | `(category_id) → categories(id)`; `(user_id) → users(id)`                                                                                                                                                          |
| `transaction_projection_state`         | 8 + 0                      | `(user_id) → users(id)`                                                                                                                                                                                            |
| `transaction_reconciliation_decisions` | 6 + 0                      | `(user_id,visible_transaction_id) → transactions(user_id,id)`; `(user_id,second_transaction_id) → transactions(user_id,id)`; `(user_id,first_transaction_id) → transactions(user_id,id)`; `(user_id) → users(id)`  |
| `transactions`                         | 16 + 0                     | `(category_id) → categories(id)`; `(user_id,reconciliation_first_id,reconciliation_second_id) → transaction_reconciliation_decisions(user_id,first_transaction_id,second_transaction_id)`; `(user_id) → users(id)` |

### Categories (`categories`)

| Table           | Stored + generated columns | Foreign keys                                              |
| --------------- | -------------------------- | --------------------------------------------------------- |
| `categories`    | 3 + 0                      | —                                                         |
| `keyword_rules` | 6 + 0                      | `(category_id) → categories(id)`; `(user_id) → users(id)` |

### Budgets (`budgets`)

| Table                       | Stored + generated columns | Foreign keys                                                         |
| --------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `budget_evaluation_work`    | 3 + 0                      | `(user_id) → users(id)`                                              |
| `budget_month_latches`      | 5 + 0                      | `(user_id,budget_id) → budgets(user_id,id)`                          |
| `budget_month_plan_records` | 7 + 0                      | `(user_id,budget_id) → budgets(user_id,id)`; `(user_id) → users(id)` |
| `budget_publications`       | 4 + 0                      | `(user_id) → users(id)`                                              |
| `budget_threshold_alerts`   | 9 + 0                      | `(user_id,budget_id) → budgets(user_id,id)`                          |
| `budget_user_state`         | 6 + 0                      | `(user_id) → users(id)`                                              |
| `budgets`                   | 9 + 0                      | `(category_id) → categories(id)`; `(user_id) → users(id)`            |

### User Documents (`user-documents`)

| Table            | Stored + generated columns | Foreign keys            |
| ---------------- | -------------------------- | ----------------------- |
| `user_documents` | 4 + 0                      | `(user_id) → users(id)` |

### Recurring Planning (`recurring-plans`)

| Table                         | Stored + generated columns | Foreign keys                                      |
| ----------------------------- | -------------------------- | ------------------------------------------------- |
| `recurring_plan_exceptions`   | 6 + 0                      | `(user_id,plan_id) → recurring_plans(user_id,id)` |
| `recurring_plan_fulfillments` | 11 + 0                     | `(user_id,plan_id) → recurring_plans(user_id,id)` |
| `recurring_plan_revisions`    | 5 + 0                      | `(user_id,plan_id) → recurring_plans(user_id,id)` |
| `recurring_plans`             | 5 + 0                      | `(user_id) → users(id)`                           |

### Recurring (`recurring`)

| Table                          | Stored + generated columns | Foreign keys            |
| ------------------------------ | -------------------------- | ----------------------- |
| `recurring_dispatch`           | 3 + 0                      | —                       |
| `recurring_evaluation_records` | 15 + 0                     | `(user_id) → users(id)` |
| `recurring_series`             | 14 + 0                     | `(user_id) → users(id)` |

### Connections (`connections`)

| Table                 | Stored + generated columns | Foreign keys                                                                    |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `connection_attempts` | 8 + 0                      | `(connection_id) → connections(id)`; `(prepared_session_id) → web_sessions(id)` |
| `connections`         | 6 + 0                      | `(user_id) → users(id)`                                                         |

### Consent (`consent`)

| Table                       | Stored + generated columns | Foreign keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consent_history`           | 23 + 6                     | `(user_id,grant_parent_type,grant_id) → consent_history(user_id,record_type,id)`; `(user_id,pat_parent_type,grant_consent_id) → consent_history(user_id,record_type,id)`; `(user_id,withdrawal_parent_type,withdrawal_id) → consent_history(user_id,record_type,id)`; `(user_id,processing_parent_type,grant_record_id) → consent_history(user_id,record_type,id)`; `(proactivity_offer_reference) → consent_offers(proactivity_offer_id)`; `(weekly_offer_reference) → consent_offers(weekly_offer_id)`; `(connection_id) → oauth_connections(id)`; `(pairing_id) → pat_pairings(id)`; `(pat_id) → pats(id)`; `(user_id) → users(id)`; `(session_id) → web_sessions(id)` |
| `consent_offers`            | 15 + 2                     | `(user_id) → users(id)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pending_consent_exchanges` | 27 + 0                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Agent (`agent`)

| Table                     | Stored + generated columns | Foreign keys                                                                                                               |
| ------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `hosted_agent_sessions`   | 10 + 0                     | `(user_id) → users(id)`                                                                                                    |
| `hosted_confirmations`    | 10 + 0                     | `(consumed_turn_id) → hosted_turns(id)`; `(issued_turn_id) → hosted_turns(id)`; `(user_id) → users(id)`                    |
| `hosted_mutation_commits` | 4 + 0                      | `(user_id,turn_id) → hosted_turns(user_id,id)`                                                                             |
| `hosted_turns`            | 26 + 1                     | `(user_id,hosted_session_id) → hosted_agent_sessions(user_id,id)`; `(document_staging_id) → statement_staging_objects(id)` |
| `transcript_entries`      | 14 + 0                     | `(user_id,hosted_session_id) → hosted_agent_sessions(user_id,id)`; `(user_id,turn_id) → hosted_turns(user_id,id)`          |

### Memory (`memory`)

| Table      | Stored + generated columns | Foreign keys            |
| ---------- | -------------------------- | ----------------------- |
| `memories` | 5 + 0                      | `(user_id) → users(id)` |

### WhatsApp (`whatsapp`)

| Table                      | Stored + generated columns | Foreign keys                                                                                                                                                                                    |
| -------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp_deliveries`      | 27 + 1                     | `(offer_id) → consent_offers(weekly_offer_id)`; `(user_id,turn_id) → hosted_turns(user_id,inbound_turn_id)`; `(user_id,insight_event_id) → insight_events(user_id,id)`; `(user_id) → users(id)` |
| `whatsapp_event_records`   | 11 + 0                     | `(correlation_token) → whatsapp_deliveries(hosted_correlation_token)`                                                                                                                           |
| `whatsapp_recipients`      | 5 + 0                      | `(user_id) → users(id)`                                                                                                                                                                         |
| `whatsapp_service_windows` | 4 + 0                      | —                                                                                                                                                                                               |

### Erasure (`erasure`)

| Table                     | Stored + generated columns | Foreign keys                                                                                                                                    |
| ------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `erasure_archives`        | 5 + 0                      | `(request_id) → erasure_requests(id)`                                                                                                           |
| `erasure_control`         | 4 + 0                      | —                                                                                                                                               |
| `erasure_custody_records` | 9 + 1                      | `(request_id,custodian,current_event_id) → erasure_custody_records(request_id,custodian,event_identity)`; `(request_id) → erasure_requests(id)` |
| `erasure_objects`         | 8 + 0                      | `(request_id) → erasure_requests(id)`                                                                                                           |
| `erasure_permits`         | 3 + 0                      | `(request_id) → erasure_requests(id)`                                                                                                           |
| `erasure_requests`        | 26 + 0                     | —                                                                                                                                               |
| `erasure_restore_members` | 3 + 0                      | —                                                                                                                                               |
| `erasure_steps`           | 5 + 0                      | `(request_id) → erasure_requests(id)`                                                                                                           |
| `erasure_writers`         | 5 + 0                      | —                                                                                                                                               |

### SQL Assertions (`src/shell/sql-assertions`)

| Table            | Stored + generated columns | Foreign keys |
| ---------------- | -------------------------- | ------------ |
| `sql_assertions` | 2 + 0                      | —            |

### Canonical Operations (`canonical-operations`)

| Table                   | Stored + generated columns | Foreign keys |
| ----------------------- | -------------------------- | ------------ |
| `canonical_child_guard` | 3 + 0                      | —            |

### Operational Health (`runtime/operational-health`)

| Table                       | Stored + generated columns | Foreign keys |
| --------------------------- | -------------------------- | ------------ |
| `operational_alerts`        | 12 + 0                     | —            |
| `operational_event_buckets` | 4 + 0                      | —            |
| `operational_health_view`   | 4 + 0                      | —            |

## Relationships enforced outside foreign keys

- The [cutover contracts](database-cutover-1428.md#typed-identities-and-relational-contracts) retain typed identities, same-User qualified references, complete optional groups, exact historical instants and Money. SQL type `TEXT` does not make two identities interchangeable.
- Variant records use their kind/type plus generated parent keys where needed. Consent basis, delivery proofs, replay identity and Audit retention authorization still require the owning atomic guards; catalog references alone do not establish authority.
- `user_documents` owns the shared root rows. Dashboard references are validated through its decoded document; Planning uses its relational stores and live Transaction/Category interfaces. Absence of a SQL foreign key is not permission to accept an arbitrary embedded identity.
- Erasure permissions address owner-defined stores and exact bounded row references. R2 ownership is the canonical stable-User prefix, with write and restore protections retained until their gates pass. These are not extra relational tables.
- Native Queue and Workflow execution, Durable Object scratch state, independent deletion markers and private object bytes live outside this D1 catalog. Their lifetime, resource and restore guarantees need separate evidence.

Reproduce the physical inventory by executing the baseline in an empty local SQLite database, then
inspecting `sqlite_schema`, `PRAGMA table_xinfo` and `PRAGMA foreign_key_list`. Native D1 migration,
rollback and public journeys remain the behavioral checks. Refresh this snapshot when the schema
blob or a gated ownership decision changes. Do not execute the baseline over populated data.
