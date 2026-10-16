# Provider inventory

Reconciled against source revision `0bd4d7d668f2c577f195360d466c530dffc90e1a` on
2026-10-15. These are source-configured services, not evidence of enabled Production account
settings, contracting entities or accepted terms. The per-flow evidence and outstanding account
checks are in the [#1275 reconciliation](provider-reconciliation-1275.md).

| Provider     | Purpose and data boundary                                                                                                                                                              | Operational/legal check                                                                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare   | Public/Core Workers, static web, D1, per-User Durable Objects, Queues, Workflows, private R2, Email Workers and Workers AI. Fidy-controlled inference stays on the Workers AI binding. | Review foreign processing, access, retention, deletion and Titular-rights obligations; do not claim Colombian physical residency.                                                                                                                                |
| Kapso / Meta | WhatsApp delivery and inbound messages; Kapso-generated voice transcripts can use additional subprocessors. Fidy does not transcribe separately.                                       | Verify the actual transcript subprocessor, account Terms/DPA, retention and deletion before real-user launch; see [Kapso launch check](kapso-launch-readiness.md). Free-plan history is not automatically deleted.                                               |
| Wompi        | Browser payment enrollment and verified Subscription billing; source adapters cover card, Nequi and DaviPlata. Fidy does not retain raw card details or wallet OTPs.                   | Verify actual merchant activation for each method; reconcile ambiguous BillingAttempts against verified evidence. See [billing ambiguity](../runbooks/billing-ambiguity.md).                                                                                     |
| Google       | OIDC authentication only (`openid email`); issuer/subject ownership, optional contact email; no mailbox access or retained provider tokens.                                            | Register the web application and exact callback, review terms/privacy, verify secret and callback-log exclusions, then run real deployed signup/login. See [Google authentication](google-authentication.md).                                                    |
| Microsoft    | OIDC only (`openid email`), personal and work/school accounts through common v2; tenant-qualified issuer/subject ownership and optional contact claims.                                | Register the multitenant + personal application, exact callback and Core secret bindings; verify real Microsoft and deployed behavior. See [Microsoft authentication](microsoft-authentication.md).                                                              |
| Resend       | Outbound authentication, recovery and service email only.                                                                                                                              | Current source declares no Resend Receiving or webhook route; authenticated account inspection found Receiving and a webhook enabled. Actual inbound use remains unverified; see the reconciliation. Source-configured forwarding uses Cloudflare Email Workers. |

This is an operator inventory, not a substitute for the User-facing [privacy policy](../../apps/site/src/assets/policy.html) or the immutable [onboarding disclosure](../../apps/server/src/shell/consent/internal/current-disclosure.ts). Any material public-copy change requires a new revision and digest; verify contracts and actual provider settings before enabling a new purpose.

Separate the Cloudflare hosting/storage, Workers AI, forwarded-email and operator Access flows;
Kapso messaging and transcription; Meta WhatsApp; and each identity provider when reviewing roles.
One commercial provider can have different roles for different purposes.

Other observed boundaries:

- Wompi source availability does not establish merchant activation. Verify each enabled payment
  method and its actual recipients. Never send wallet identifiers or OTPs in a rights request.
- GitHub serves public CLI release metadata through a fixed anonymous server request. This is an
  observed service boundary, not another recipient of Fidy User financial payloads. Review installer
  traffic separately if its actual use introduces a personal-data flow.
- The support mailbox and restricted case evidence are actual operator custodians from #1273/#1274.
  The current mailbox provider and any backup service are unverified here; do not infer Google
  Workspace from a Google login or Resend from outbound service email.
- User-selected external agents receive data under the User's own grants. Their model providers
  are not automatically Fidy subprocessors. Review a Fidy-contracted integration if one is added.

The accepted Kapso Free-plan indefinite-history MVP exception remains in force. The separate
[#713 launch evidence](kapso-launch-readiness.md) is not passed by this inventory or reopened by
#1275. Public subprocessor changes require reconciliation with the actual Fidy route before adding
a provider to the deployed-chain record.
