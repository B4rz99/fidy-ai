# Sentry Developer plan limits, retention, and data-region constraints

- **Ticket:** [B4rz99/fidy-ai#93](https://github.com/B4rz99/fidy-ai/issues/93)
- **Map:** [B4rz99/fidy-ai#91](https://github.com/B4rz99/fidy-ai/issues/91)
- **Checked:** 2026-08-04 UTC
- **Method:** Sentry pricing, Sentry documentation, Sentry API reference, Sentry Help Center, and Sentry legal/privacy material only. Fast-changing values below are the values visible in those first-party sources on the check date.

## Executive answer

**Sourced fact:** The current free plan is **Developer**. The live pricing comparison lists one user, unlimited projects, 5,000 errors, 5M spans, 50 session replays, 5 GB of logs, one cron monitor, one uptime monitor, 20 metric monitors, email issue alerts, and a 30-day lookback. Sentry's August 2025 first-party plan-change notice confirms the Developer baseline as 5k errors, 5 GB logs, 5M spans, 50 replays, 1 cron monitor, 1 uptime monitor, and 1 GB attachments. The plan page does not print `/month` next to every free-plan row, but Sentry's quota documentation and Help Center describe the quota as a monthly/usage-period allowance. ([pricing comparison](https://sentry.io/pricing/); [Sentry plan-change notice](https://www.sentry.help/en/articles/13965033-how-is-my-plan-changing-august-27-2025); [quota documentation](https://docs.sentry.io/pricing/quotas/); [exhausted-quota guidance](https://www.sentry.help/en/articles/13964891-i-ve-exhausted-my-quota-what-now))

**Conclusion for Fidy:** Create separate production and local Sentry projects in one organization, with a distinct DSN/client key for each, because the Developer plan permits unlimited projects and Sentry uses projects to scope services. Treat the 5k-error and 5M-span allowances as **shared organization capacity**, not as a fresh allowance per project: Sentry reports usage across the entire organization and breaks it down by project. Keep local capture opt-in and apply a small local DSN rate limit/spike guard so local traffic cannot consume the production budget. This is a conclusion from organization-scoped quota documentation; verify the exact pool and reset date in the real organization’s Subscription and Stats pages. ([Fidy map decision](https://github.com/B4rz99/fidy-ai/issues/91); [projects](https://docs.sentry.io/product/projects/); [Stats](https://docs.sentry.io/product/stats/); [quota overview](https://docs.sentry.io/pricing/quotas/))

**Most important constraint:** Developer cannot add reserved volume or a pay-as-you-go budget. Going above its allowance requires upgrading to Team or Business. Once a monthly quota is exhausted, new events are not accepted until the next usage period unless the organization has an eligible paid capacity. ([reserved-volume article](https://www.sentry.help/en/articles/13964872-can-i-add-more-reserved-volumes-to-my-free-developer-plan); [PAYG article](https://www.sentry.help/en/articles/13965037-can-i-set-up-an-on-demand-pay-as-you-go-budget-for-my-free-developer-plan); [exhausted-quota guidance](https://www.sentry.help/en/articles/13964891-i-ve-exhausted-my-quota-what-now))

## 1. Developer plan limits

### 1.1 Current public baseline

| Category               |                          Developer value | Meaning for Fidy                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users                  |                               **1 user** | The free organization is not a multi-member operator workspace. Verify whether the eventual operator/admin workflow needs a paid plan.                                                            |
| Projects               |                            **Unlimited** | Two projects (at minimum production and local) fit the plan. This does not create separate quotas.                                                                                                |
| Error Monitoring       |                            **5k errors** | Error events use a separate error allowance from tracing spans. The public comparison calls this `5k errors`; the first-party plan-change notice confirms the current Developer baseline.         |
| Tracing                |                             **5M spans** | Tracing is billed/limited by accepted spans. A trace has no separate quota; its accepted errors, transactions, and spans consume their corresponding categories.                                  |
| Session Replay         |                           **50 replays** | Not in the Fidy map; disable it rather than spend the small free allowance.                                                                                                                       |
| Logs                   |                                 **5 GB** | The map excludes raw application logs; do not enable log capture accidentally.                                                                                                                    |
| Attachments            |                                 **1 GB** | The plan-change notice lists this baseline. Avoid attachments because Fidy's observability policy is metadata-only. ([map #91](https://github.com/B4rz99/fidy-ai/issues/91))                      |
| Cron / Uptime          |                               **1 each** | These are resource counts, not event quotas. The free plan cannot add another cron monitor without a paid plan.                                                                                   |
| Metric Monitors        |                                   **20** | This is the clearest numeric alert/monitor limit in the live comparison. A metric monitor detects a threshold and creates an issue; an Alert routes notifications for that issue.                 |
| Issue alerts           |                      **Email available** | The live comparison shows email alerts for Developer. It does not publish a numeric cap on issue-alert rules or alert executions.                                                                 |
| Integrated alert tools | **Not shown as available for Developer** | The live comparison's integrated-tools row is blank for Developer, while generic alert docs describe Slack/PagerDuty/etc. Verify the actual free organization before depending on an integration. |
| Data retention         |                      **30-day lookback** | The detailed retention table below gives the data-type-specific result.                                                                                                                           |

The numeric rows above are sourced from the [live Sentry pricing comparison](https://sentry.io/pricing/) and the [first-party August 2025 plan-change notice](https://www.sentry.help/en/articles/13965033-how-is-my-plan-changing-august-27-2025). The distinction between monitors and alerts, and the available alert actions, is documented in Sentry's [Monitors and Alerts guide](https://docs.sentry.io/product/monitors-and-alerts/monitors/) and [Alerts guide](https://docs.sentry.io/product/monitors-and-alerts/alerts/).

### 1.2 What “event”, “error”, “transaction”, “span”, and “trace” mean

- **Sourced fact:** Sentry defines an event as one instance of sending data, generally an error or transaction/span; issues themselves are not a billable event. A span is both the basic unit of a trace and the billing unit for tracing. ([quota terminology](https://docs.sentry.io/pricing/quotas/))
- **Sourced fact:** Sentry's current SaaS tracing model uses transactions/spans as the tracing unit. The components of a trace consume quota when accepted; the trace as a collection does not consume an additional quota. ([Sentry Help Center: traces and quota](https://www.sentry.help/en/articles/13964835-do-traces-count-against-our-quota); [tracing quota guide](https://docs.sentry.io/pricing/quotas/manage-transaction-quota/))
- **Conclusion:** There is no additional “generic events” bucket to add to the 5k error and 5M span planning numbers, and no separately published free-plan transaction count in the current sources. Plan against accepted errors and accepted spans, not trace count.
- **Sourced fact:** Only accepted data affects quota. SDK sampling, SDK callbacks, inbound filters, DSN rate limits, spike protection, quota exhaustion, and other server-side drop paths can prevent acceptance; deleting an already accepted event does not restore quota. ([quota overview](https://docs.sentry.io/pricing/quotas/); [delete-events guidance](https://www.sentry.help/en/articles/13964869-is-it-possible-to-delete-events-to-free-up-quota))

For the map's intended **100% production error capture**, the 5k error allowance is the hard monthly planning ceiling unless the organization upgrades. Production tracing must be sampled or otherwise bounded; 5M spans is the shared ceiling before accepted tracing data is dropped. Those are planning conclusions, not guarantees about Fidy's future traffic. ([map #91](https://github.com/B4rz99/fidy-ai/issues/91))

### 1.3 Trial and legacy-plan traps

- New accounts receive a 14-day trial. After an account does not upgrade, it remains on the limited Developer plan. Product trials can temporarily permit unlimited events for the trial period, so a new organization can look less constrained than its post-trial Developer state. ([current pricing/billing docs](https://docs.sentry.io/pricing/))
- The current billing docs explicitly say they apply to Sentry's latest pricing plan and link older pricing for older organizations. The account's **Subscription** page is therefore authoritative if an existing organization was created under an older plan or is still in a transition. ([latest pricing docs](https://docs.sentry.io/pricing/); [legacy pricing docs](https://docs.sentry.io/pricing/legacy-pricing/))
- Developer has no option to add a credit card for reserved volume or to configure PAYG. ([reserved-volume article](https://www.sentry.help/en/articles/13964872-can-i-add-more-reserved-volumes-to-my-free-developer-plan); [PAYG article](https://www.sentry.help/en/articles/13965037-can-i-set-up-an-on-demand-pay-as-you-go-budget-for-my-free-developer-plan))

## 2. Production and local projects; what is shared

### 2.1 Recommended shape

The map already requires separate Sentry projects for production and local, with local capture opt-in. ([map #91](https://github.com/B4rz99/fidy-ai/issues/91))

**Sourced facts:** Sentry describes a project as a service or application and assigns each project its own DSN. It recommends separate projects for distinct application components such as a React frontend and an Express backend. Environments are intended to distinguish deployment stages inside projects. ([projects](https://docs.sentry.io/product/projects/); [frontend/backend project tutorial](https://docs.sentry.io/product/sentry-basics/getting-started-tutorial/create-new-project/); [environments](https://docs.sentry.io/concepts/key-terms/environments/))

**Conclusion:** “Production” and “local” should be separate projects at minimum. The final project count still needs a Fidy decision: Sentry's own component guidance could imply production/local × SPA/API projects rather than exactly two projects. Unlimited projects removes the plan-count pressure, but every added project still shares the organization pool and adds a DSN/key to manage.

### 2.2 Shared quota implication

Sentry's Stats page describes usage **across the entire organization**, then provides a per-project breakdown. Its quota documentation likewise describes quotas by data category and identifies projects as consumers of the organization quota. ([Stats](https://docs.sentry.io/product/stats/); [quota management](https://docs.sentry.io/pricing/quotas/); [error quota guide](https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/))

**Conclusion:** Two projects in the same Developer organization do not each receive 5k errors and 5M spans. They draw from the same organization-level category allowances. A local environment can therefore exhaust or materially reduce production capacity even though its events are in a different project. A DSN rate limit, sampling, filtering, or spike protection is a guardrail, not additional quota.

If hard usage or data-region isolation is required, Sentry documents that organizations are managed separately for subscriptions, usage, users, projects, and related settings. Creating a second organization is therefore the documented isolation boundary, but the sources do not establish whether using multiple free Developer organizations is permitted or desirable. ([data storage location](https://docs.sentry.io/organization/data-storage-location/))

### 2.3 Environment constraints

- Environments are automatically created from the event's `environment` value. Names are case-sensitive, cannot contain newlines, spaces, or `/`, cannot be `None`, and cannot exceed 64 characters. ([environment documentation](https://docs.sentry.io/concepts/key-terms/environments/))
- Environments cannot be deleted; they can only be hidden. Events sent to a hidden environment still count against quota. ([environment documentation](https://docs.sentry.io/concepts/key-terms/environments/))
- Alerts can be scoped to selected environments, but issue alerts run across all environments by default. ([Alerts guide](https://docs.sentry.io/product/monitors-and-alerts/alerts/))
- The public environment documentation gives naming rules but no numeric maximum number of environments. That maximum is unresolved and must be checked in the account if it matters.

**Conclusion:** Set `environment` explicitly to stable values such as `production` and `local`; do not rely on SDK packaging defaults. Keep local capture disabled unless deliberately enabled, and scope production alerts explicitly rather than inheriting an all-environment default.

## 3. Alert and monitor limits

Sentry's current model separates detection from notification:

- A **Monitor** defines what to track and when to create an issue. Metric monitors can inspect errors, spans, logs, releases, and application metrics. ([Monitors guide](https://docs.sentry.io/product/monitors-and-alerts/monitors/))
- An **Alert** routes a resulting issue to email, integrations, tickets, webhooks, or other actions, subject to plan and integration availability. ([Alerts guide](https://docs.sentry.io/product/monitors-and-alerts/alerts/))
- The live Developer comparison lists **20 Metric Monitors** and email issue alerts. It does not publish a numeric issue-alert count, notification-run allowance, or webhook-delivery allowance for Developer. ([pricing comparison](https://sentry.io/pricing/))
- The free plan includes one cron and one uptime monitor; Sentry's Help Center says a Developer organization cannot have more than one cron monitor and additional cron monitors require a paid plan. ([plan-change notice](https://www.sentry.help/en/articles/13965033-how-is-my-plan-changing-august-27-2025); [cron limit article](https://www.sentry.help/en/articles/13963931-how-do-i-can-i-get-more-crons-on-a-developer-plan))

**Conclusion:** For the map, reserve the 20-monitor count for slow-operation/error/span/application-metric detectors. Treat “alert count” as undocumented rather than unlimited. Use email as the only free-plan channel unless the account proves otherwise. Do not count alerts as events; the monitored errors/spans/metrics are the data that consume their respective quotas.

### Alert API note

The current API reference creates alerts at the organization level, connects them to monitor IDs, allows an environment, and supports frequency/throttle configuration. ([create organization alert](https://docs.sentry.io/api/monitors/create-an-alert-for-an-organization/); [list organization monitors](https://docs.sentry.io/api/monitors/fetch-an-organizations-monitors/))

Sentry's first-party Help Center says the legacy alert APIs are scheduled for removal on **2026-08-17** and directs users to the new Monitors and Alerts endpoints. Any future Fidy automation should use the current API rather than copying a legacy endpoint. ([migration notice](https://www.sentry.help/en/articles/15015315-migrating-to-new-detectors-and-alerts-apis))

## 4. Retention

### 4.1 Developer retention table

Sentry's current retention table gives Developer the following retention for data ingested while the organization is on Developer:

| Data type           | Developer retention |
| ------------------- | ------------------: |
| Errors              |             30 days |
| Logs                |             30 days |
| Spans/Transactions  |             30 days |
| Session Replays     |             30 days |
| Profiles            |             30 days |
| Crons               |             30 days |
| Uptime              |             30 days |
| Attachments         |             30 days |
| Size Analysis       |             30 days |
| Application Metrics |             30 days |

([Sentry data retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/))

Retention is fixed when data is ingested based on the then-current plan. Upgrading or downgrading changes retention for new data only; existing data keeps its original retention period. ([Sentry data retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/); [retention change notice](https://www.sentry.help/en/articles/13965030-data-retention-notice-august-27-2025))

**Fidy conclusion:** Design operator investigations around a 30-day Sentry lookback on Developer. Do not treat Sentry as the long-term audit or application record. This aligns with the map's operator-only, metadata-only scope; it is not a recommendation to retain financial or conversational content in Sentry.

### 4.2 Releases and source-map artifacts are a separate retention question

- Sentry's general data-retention table does **not** list release records, debug symbols, or source maps.
- Debug-ID artifacts have a documented **90-day time-to-idle** lifetime: they remain while actively used for event processing and become eligible for expiry after 90 days without use. This is not the same as the 30-day error-event retention. ([Debug IDs](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/debug-ids/))
- Release records themselves have no fixed retention period stated in the primary sources checked here. This remains unresolved.

## 5. Data region and processing

### 5.1 Storage region

Sentry SaaS offers two organization storage locations: **US (Iowa)** and **EU (Frankfurt)**. The choice is made when creating an organization and cannot be changed for an existing SaaS organization; switching requires a new organization. ([data storage location](https://docs.sentry.io/organization/data-storage-location/))

The selected location stores error events, activity and issue links, transactions, spans, profiles, logs, metrics, release health, releases, debug symbols, source maps, session replays, and backups for those resources. ([data storage location](https://docs.sentry.io/organization/data-storage-location/))

The same page says that the following may still be stored in the US regardless of selection: user accounts and settings, integration metadata, access tokens, organization settings/configuration/teams, audit logs, cron check-ins, project metadata, DSN keys, detailed usage data, Sentry applications, and SSO/SAML/SCIM metadata. Organization-identifying metadata may be replicated to the US for login and backwards-compatible APIs; support-ticket/chat data is stored in the US; uptime checks are stored in all data locations. ([data storage location](https://docs.sentry.io/organization/data-storage-location/))

**Conclusion:** A single organization means production and local projects share the same storage-region choice. An EU organization provides EU at-rest storage for event data and release artifacts, but it is not a promise that every related piece of metadata or support interaction stays in the EU.

### 5.2 Processing is broader than at-rest location

Sentry explicitly describes the storage-location selection as determining **data storage location only** and says Sentry continues to access and process data under the Sentry agreement and Privacy Policy. ([data storage location](https://docs.sentry.io/organization/data-storage-location/))

The Sentry DPA says Sentry is a processor of Customer Data and may store and process Customer Data in the United States and any other country where Sentry or its subprocessors maintain processing operations. The DPA also prohibits customers from submitting sensitive personal information/special categories to Sentry. ([Sentry DPA](https://sentry.io/legal/dpa/))

Sentry's Privacy Policy separately says the Service is hosted in the United States and Germany and that affiliates and service providers operate around the world. ([Sentry Privacy Policy](https://sentry.io/privacy/))

**Conclusion:** If Fidy requires “EU-only processing,” the EU storage setting alone is insufficient evidence. The account owner must review the current DPA, subprocessor list, transfer mechanism, and any applicable Colombian privacy/compliance requirements. Fidy's metadata-only deny-by-default policy is the safer boundary, but the legal acceptability of the selected region and processing terms remains an account/compliance verification item.

### 5.3 Endpoint guidance conflict

The storage-location page gives these region-specific API domains:

- US: `us.sentry.io`
- EU: `de.sentry.io`

Later on the same page it says, “For data stored in the US, your API domain should be `sentry.io`.” That conflicts with the earlier US `us.sentry.io` table entry. The page is therefore not sufficient to justify hand-constructing an ingestion endpoint. Use the DSN generated in **Project Settings → SDK Setup → Client Keys (DSN)** and test it from the account's selected region. ([data storage location](https://docs.sentry.io/organization/data-storage-location/); [DSN explainer](https://docs.sentry.io/concepts/key-terms/dsn-explainer/); [client-key API example](https://docs.sentry.io/api/projects/create-a-new-client-key/))

## 6. DSNs and client keys

- A project receives a DSN when it is created. The DSN tells the SDK where to send events and associates them with the project. An absent DSN means the SDK sends no events. ([DSN explainer](https://docs.sentry.io/concepts/key-terms/dsn-explainer/); [JavaScript SDK `dsn` option](https://docs.sentry.io/platforms/javascript/configuration/options/))
- Each project has its own unique DSN. Sentry says DSNs are safe to keep public because they permit submission of new events but not read access. The remaining abuse risk is that somebody can submit unwanted data, so Sentry provides IP blocking, key rotation, and revocation controls. ([DSN explainer](https://docs.sentry.io/concepts/key-terms/dsn-explainer/))
- Multiple client keys can exist for one project. The event-quota guide explicitly supports different limits—or no limit—per key, which makes separate production/local keys possible even within one project. ([event quota guide](https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/))
- The client-key API can create, update, activate, deactivate, and rate-limit a key. A key's `rateLimit` has a window in seconds and an error count; `null` disables that key-specific rate limit. ([create client key](https://docs.sentry.io/api/projects/create-a-new-client-key/); [update client key](https://docs.sentry.io/api/projects/update-a-client-key/); [delete client key](https://docs.sentry.io/api/projects/delete-a-client-key/))

**Fidy conclusion:** Store production and local DSNs separately in their own deployment configuration. Do not treat a DSN as an API read credential, and never put an Sentry organization auth token in a browser bundle; Sentry documents auth tokens as the credential for its REST API, unlike public DSNs. Use the account-generated DSN/host rather than copying the example DSN from API docs. ([Sentry API authentication](https://docs.sentry.io/api/auth/))

## 7. Rate limits and quota exhaustion

There are three different mechanisms that should not be conflated.

### 7.1 Organization quota exhaustion

When an organization runs out of its event/category quota, Sentry can return **HTTP 429** with a `Retry-After` header. The SDK/client should stop retrying and drop telemetry until the limit expires; Sentry says the response can be delayed because ingestion and rate limiting are asynchronous. ([error quota guide](https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/); [span quota guide](https://docs.sentry.io/pricing/quotas/manage-transaction-quota/); [429 Help Center article](https://www.sentry.help/en/articles/13965132-why-am-i-getting-429-too-many-requests-responses-from-sentry))

### 7.2 Per-DSN error rate limit

A client-key limit caps the number of **error events accepted by that key** during a configured window. The UI documents daily, hourly, or minute-based windows, with an example such as 500 events per minute. The API represents the window in seconds plus an error count. There is no published default numeric value; `7200 seconds / 1000 errors` in the API page is an example request, not a Developer-plan default. Events rejected by this limit produce 429s. ([event quota guide](https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/); [create client key](https://docs.sentry.io/api/projects/create-a-new-client-key/); [429 Help Center article](https://www.sentry.help/en/articles/13965132-why-am-i-getting-429-too-many-requests-responses-from-sentry/))

The documented client-key limit is for errors. The span guide gives no numeric per-DSN span limit; span volume should be controlled with `tracesSampleRate`, `tracesSampler`, `beforeSendTransaction`, and span filtering. ([span quota guide](https://docs.sentry.io/pricing/quotas/manage-transaction-quota/); [JavaScript options](https://docs.sentry.io/platforms/javascript/configuration/options/))

### 7.3 Spike protection and SDK controls

Spike Protection can be enabled per project and dynamically drops errors, transactions/spans, and attachments after a computed project threshold. It is a safety ceiling and can drop legitimate telemetry; it does not add capacity. SDK sampling and `beforeSend*` filtering reduce what is sent before ingestion. ([Spike Protection](https://docs.sentry.io/pricing/quotas/spike-protection/); [quota overview](https://docs.sentry.io/pricing/quotas/))

### 7.4 Sentry REST API limits

The Sentry REST API has a different limiter: each unique caller/endpoint combination has a fixed-window requests-per-second limit and a concurrent-request limit. Responses expose `X-Sentry-Rate-Limit-Limit`, `...-Remaining`, `...-Reset`, and concurrent-limit headers. The API documentation does not publish one universal numeric limit because each endpoint has its own maximum/window. These limits apply to release uploads, alert configuration, Stats queries, and other API calls; they are not the same as event ingestion quotas. ([API rate limits](https://docs.sentry.io/api/ratelimits/))

**Fidy conclusion:** Sentry transport failures, 429s, and quota exhaustion must be non-fatal to Fidy. Use bounded/best-effort telemetry queues, honor rate-limit responses, and do not retry rejected event payloads indefinitely. ([map #91](https://github.com/B4rz99/fidy-ai/issues/91))

## 8. Releases and source maps

### 8.1 Documented support path

- A release is a deployed code version; setting an SDK release identifier lets Sentry associate errors and regressions with that version. ([releases](https://docs.sentry.io/product/releases/); [JavaScript `release` option](https://docs.sentry.io/platforms/javascript/configuration/options/))
- Sentry documents `sentry-cli` release creation/finalization, deploy notification, commit association, and source-map upload. ([CLI releases](https://docs.sentry.io/cli/releases/); [release setup](https://docs.sentry.io/product/releases/setup/))
- Sentry's JavaScript source-map documentation supports a wizard and bundler/CLI upload flows, says source maps are normally generated/uploaded for production builds, and requires the artifacts to be uploaded before the relevant errors occur. ([JavaScript source maps](https://docs.sentry.io/platforms/javascript/sourcemaps/); [source-map troubleshooting](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/))
- Debug IDs are the recommended current JavaScript association mechanism; the docs require SDK 7.47 or newer for the documented Debug ID path. ([Debug IDs](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/debug-ids/))
- Sentry's current pricing comparison shows Release Health available in the Developer column, and the storage-region page lists releases, debug symbols, and source maps as selected-region resources. The generic release/source-map documentation does not state a Developer-only exclusion. ([pricing comparison](https://sentry.io/pricing/); [data storage location](https://docs.sentry.io/organization/data-storage-location/))

**Conclusion:** Release identifiers and source-map upload are supported workflows to plan for on Developer, but the public sources do not publish a Developer-specific source-map artifact count/GB quota. Verify an actual free project by uploading a non-sensitive test artifact and checking the Source Maps UI before relying on it for production.

### 8.2 Two constraints for separate projects

- Releases are global per organization. If different projects use the same version name and should remain distinct, Sentry says to make the release name unique across the organization. ([CLI releases](https://docs.sentry.io/cli/releases/))
- Debug-ID artifacts have the separate 90-day time-to-idle retention described above. General release-record retention is not stated in the checked primary sources. ([Debug IDs](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/debug-ids/))

**Fidy conclusion:** Use an explicit, project-qualified release naming convention for production/local and for SPA/API if those become separate projects; upload source maps before deployment; do not upload source maps containing financial or conversational content, consistent with the map's metadata-only boundary and Sentry's DPA restriction on sensitive data. ([map #91](https://github.com/B4rz99/fidy-ai/issues/91); [Sentry DPA](https://sentry.io/legal/dpa/))

## 9. Account settings that require verification

Before implementation is treated as bounded by the free plan, an Owner should record screenshots or API outputs for:

1. **Organization → Subscription:** confirm the organization is actually Developer rather than in a 14-day/product trial or on a legacy plan; record the live error, span, logs, attachments, monitor, retention, usage-period reset, and one-user values. ([pricing/billing](https://docs.sentry.io/pricing/); [legacy pricing](https://docs.sentry.io/pricing/legacy-pricing/))
2. **Organization → Stats:** confirm that production and local projects draw from one organization pool, and monitor accepted, filtered, rate-limited, invalid, and client-discarded data by category/project. ([Stats](https://docs.sentry.io/product/stats/))
3. **Organization → Data Storage Location:** record US or EU, then retain the current DPA/subprocessor terms. Do not assume the selected at-rest region means EU-only processing. ([data storage location](https://docs.sentry.io/organization/data-storage-location/); [DPA](https://sentry.io/legal/dpa/); [subprocessors](https://sentry.io/legal/subprocessors/))
4. **Project list and Project Teams:** verify the intended project count (at minimum production and local; potentially component-specific projects), project ownership, and the one-user limitation. ([projects](https://docs.sentry.io/product/projects/); [membership](https://docs.sentry.io/organization/membership/))
5. **Project → SDK Setup → Client Keys (DSN):** capture the generated DSN/region host for each project, ensure the key is active, and configure/test a separate local key. ([DSN explainer](https://docs.sentry.io/concepts/key-terms/dsn-explainer/); [client-key API](https://docs.sentry.io/api/projects/create-a-new-client-key/))
6. **Client-key rate limits:** set and test a local error ceiling; decide whether production needs only Spike Protection or an explicit per-key ceiling. Verify how 429s appear in the SDK and Stats. ([event quota guide](https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/); [Spike Protection](https://docs.sentry.io/pricing/quotas/spike-protection/))
7. **Project → Environments:** set explicit `production`/`local` values, hide accidental values if desired, and remember that hiding does not refund quota. ([environments](https://docs.sentry.io/concepts/key-terms/environments/))
8. **Project → Inbound Filters and Security & Privacy:** verify localhost/extension/crawler filters, IP blocks, Data Scrubber, and any organization attachment limit. Ensure they do not undermine intentional production error capture and do not permit Fidy content into telemetry. ([error quota guide](https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/); [Sentry security](https://sentry.io/security/))
9. **Project → Monitors and Alerts:** confirm the 20 metric-monitor allowance, email delivery, available integrations, environment scoping, alert frequency/throttle, and whether the account has migrated to the current Monitors/Alerts API. ([pricing comparison](https://sentry.io/pricing/); [Monitors and Alerts](https://docs.sentry.io/product/monitors-and-alerts/); [API migration notice](https://www.sentry.help/en/articles/15015315-migrating-to-new-detectors-and-alerts-apis))
10. **Project → Source Maps and release test:** upload a harmless test bundle from the real production build pipeline, confirm Debug ID matching, check artifact visibility/retention, and verify the release name and environment shown on a test event. ([source maps](https://docs.sentry.io/platforms/javascript/sourcemaps/); [Debug IDs](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/debug-ids/); [CLI releases](https://docs.sentry.io/cli/releases/))
11. **SDK privacy settings:** verify `sendDefaultPii`, `dataCollection`, `beforeSend`, `beforeSendTransaction`, and `beforeSendSpan` are explicitly configured for the map's metadata-only policy; Sentry's current JavaScript defaults can collect user information, cookies, headers, URLs, bodies, stack-frame variables, and generative-AI inputs/outputs unless configured otherwise. ([JavaScript options](https://docs.sentry.io/platforms/javascript/configuration/options/))

## 10. Conflicts and unresolved questions

### Conflicts or source omissions

1. **Current comparison versus billing prose:** The live pricing comparison and Sentry's first-party August 2025 plan-change notice show Developer at 5k errors and 5M spans. The current billing prose primarily enumerates paid-plan base volume and links legacy pricing; it does not repeat every Developer numeric row. Use the live account Subscription page to resolve any discrepancy. ([pricing comparison](https://sentry.io/pricing/); [plan-change notice](https://www.sentry.help/en/articles/13965033-how-is-my-plan-changing-august-27-2025); [latest billing docs](https://docs.sentry.io/pricing/))
2. **Region endpoint wording:** The storage-location page lists `us.sentry.io` for US, then later says US should use `sentry.io`. Use the account-generated DSN and verify ingestion rather than choosing manually. ([data storage location](https://docs.sentry.io/organization/data-storage-location/); [DSN explainer](https://docs.sentry.io/concepts/key-terms/dsn-explainer/))
3. **Alerts feature wording:** Generic alert docs describe integrations, while the live Developer comparison shows email alerts but no integrated-tools entitlement. Confirm the actual plan UI and test delivery. ([pricing comparison](https://sentry.io/pricing/); [Alerts guide](https://docs.sentry.io/product/monitors-and-alerts/alerts/))
4. **Retention terminology:** Developer event data is documented at 30 days, while Debug-ID artifacts have 90-day time-to-idle retention. These are different data classes, not a reason to promise 90-day event retention. ([retention table](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/); [Debug IDs](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/debug-ids/))

### Unresolved questions

- Does the live Developer organization expose exactly one pooled 5k-error/5M-span allowance across all of Fidy's projects, and what is the exact reset timestamp? The organization-scoped docs strongly imply yes, but the public free-plan table does not spell out the pool in those words.
- Is the intended project shape exactly two projects (production/local), or should each component (SPA/API/worker) also have a project, producing production/local × component projects? Sentry recommends project-per-service/component, but the Fidy map only closes the production/local split.
- Are integrated alert tools, source-map uploads, and the new Monitors/Alerts API fully enabled for this specific free Developer organization, or only email alerts and 20 metric monitors? The public sources do not provide a complete free-plan feature matrix for these items.
- What is the retention/deletion policy for release records and non-Debug-ID source-map artifacts? The checked primary sources specify 30-day event retention and 90-day idle Debug-ID artifact retention but not a general release-record period.
- Which ingestion/API hostname should be allowlisted for the selected region, given the contradictory US endpoint wording? The generated DSN and a real test event should decide.
- Does Sentry's current DPA/subprocessor arrangement meet Fidy's required data-region/compliance posture? EU storage is not documented as EU-only processing, and the DPA permits processing in the US and other subprocessor locations.
- Are multiple free Developer organizations an acceptable way to isolate usage or region, or would Sentry/account terms disallow treating them as quota partitions? The sources document separate organization accounting but do not answer this policy question.
- What numeric Sentry REST API requests-per-second and concurrent limits apply to the specific release, source-map, Stats, and alert endpoints? The API publishes response headers and says limits are endpoint-specific, but no universal numeric table was found.

## First-party sources consulted

- [Sentry pricing comparison](https://sentry.io/pricing/)
- [Sentry Pricing & Billing](https://docs.sentry.io/pricing/)
- [Sentry quota management](https://docs.sentry.io/pricing/quotas/)
- [Manage event/error quota](https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/)
- [Manage span quota](https://docs.sentry.io/pricing/quotas/manage-transaction-quota/)
- [Spike Protection](https://docs.sentry.io/pricing/quotas/spike-protection/)
- [Data retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/)
- [Data storage location](https://docs.sentry.io/organization/data-storage-location/)
- [DSN explainer](https://docs.sentry.io/concepts/key-terms/dsn-explainer/)
- [Environments](https://docs.sentry.io/concepts/key-terms/environments/)
- [Projects](https://docs.sentry.io/product/projects/)
- [Monitors](https://docs.sentry.io/product/monitors-and-alerts/monitors/)
- [Alerts](https://docs.sentry.io/product/monitors-and-alerts/alerts/)
- [Sentry API rate limits](https://docs.sentry.io/api/ratelimits/)
- [Create/update client keys](https://docs.sentry.io/api/projects/create-a-new-client-key/), [update](https://docs.sentry.io/api/projects/update-a-client-key/), [delete](https://docs.sentry.io/api/projects/delete-a-client-key/)
- [Monitors & Alerts API](https://docs.sentry.io/api/monitors/), [create organization alert](https://docs.sentry.io/api/monitors/create-an-alert-for-an-organization/)
- [Releases](https://docs.sentry.io/product/releases/), [release setup](https://docs.sentry.io/product/releases/setup/), [CLI releases](https://docs.sentry.io/cli/releases/)
- [JavaScript source maps](https://docs.sentry.io/platforms/javascript/sourcemaps/), [Debug IDs](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/debug-ids/)
- [Sentry DPA](https://sentry.io/legal/dpa/), [Privacy Policy](https://sentry.io/privacy/), [subprocessors](https://sentry.io/legal/subprocessors/)
- [Sentry Help Center: current free-plan change](https://www.sentry.help/en/articles/13965033-how-is-my-plan-changing-august-27-2025), [Developer reserved volume](https://www.sentry.help/en/articles/13964872-can-i-add-more-reserved-volumes-to-my-free-developer-plan), [Developer PAYG](https://www.sentry.help/en/articles/13965037-can-i-set-up-an-on-demand-pay-as-you-go-budget-for-my-free-developer-plan), [429 behavior](https://www.sentry.help/en/articles/13965132-why-am-i-getting-429-too-many-requests-responses-from-sentry)
