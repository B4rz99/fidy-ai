# Provider reconciliation — #1275

Status: **in progress; not provider readiness approval**. Source inspection on 2026-10-15 uses
`0bd4d7d668f2c577f195360d466c530dffc90e1a`. Current public-source findings are recorded separately in
[provider public evidence](../research/provider-public-evidence-1275.md). Public terms establish
published provisions, not Fidy's accepted agreement, configured route or compliance.

`obarboza@fidyapp.com` owns account evidence collection and the existing Titular procedure. There is
no backup operator. The already approved #1273 procedure and queued-work cutoff remain approved;
this record does not reopen them. **Per-flow roles, international-processing mechanisms and actual
account applicability have not been reviewed here by a qualified reviewer.** That is the distinct
review required by #1275, not a new requirement to approve withdrawal.

## Observations and evidence custody

- The [stack](../../infra/cloudflare/alchemy.run.ts) wires Cloudflare, Kapso, Resend, Wompi and
  Google/Microsoft credentials. Declared bindings do not prove live service activation.
- The [outbound owner](../../apps/server/src/shell/outbound-http/operations.ts) and its fixed
  destinations identify the implemented external HTTP routes. Workers AI uses the native binding.
  No separate Fidy transcription service is declared.
- The account browser inventory exposed no existing account tabs on 2026-10-15. Opening Cloudflare
  redirected to its login screen; no authenticated Cloudflare configuration was inspected. The
  `kapso` executable was not available on this checkout's command path. These observations prove
  neither absent accounts nor absent agreements.
- The earlier dated `fiidy` sandbox-project observation remains in
  [Kapso evidence](kapso-launch-evidence.json); it is not a current account verification.
- No provider contact, agreement acceptance, purchase, live deletion or disclosure of private
  evidence was performed for this reconciliation.

Keep original agreements, acceptance receipts, account settings, correspondence and identifiers in
the existing #1273 encrypted evidence location outside Git. Restrict access to the sole operator
and explicitly authorized reviewers, including backups. Use opaque evidence references in this
document or GitHub; a reference is not proof unless its private source exists. Do not collect HARs,
access tokens, session cookies, API keys, card details, OTPs or recovery proofs as evidence.

For each private flow record retain: flow ID; actual service/account and contracting Fidy entity;
provider legal entity; enabled product, environment and plan; purposes and data classes; observed
processing/storage/support-access locations with uncertainties; actual terms/DPA version and
acceptance source; processing instructions; security/confidentiality provisions; rights and incident
channels; applicable subprocessors; retention/deletion and backup/log exceptions; observed date;
evidence references; reviewer identity, qualification, review date and decision version; legal role,
transfer/transmission classification and mechanism with its actual source; next review/change trigger.
An unsigned draft or publicly downloaded DPA stays unverified for the actual account.

## Flow reconciliation

Every row below has account evidence **unverified**, reviewer **not recorded**, and owner
**obarboza@fidyapp.com**. None has an approved legal classification or international mechanism in
this record. The next steps are specific to the flow; do not treat these rows as a completed review.
The public-source note supplies candidate documents and their applicability limits.

| Flow         | Source-confirmed purpose and data                                                                                                                                                                                  | Account evidence and review needed next                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CF-runtime   | Public/Core Workers, static assets, D1, per-User Durable Objects, Queues, Workflows and private R2 process/store identity, financial records, messages, originals and security evidence.                           | Identify company account, plan, actual resources, region/jurisdiction settings, enabled logging and support access; match its applicable Cloudflare agreement/DPA and subprocessors. Separate customer-content processing from provider account/security purposes.            |
| CF-AI        | Workers AI receives the bounded hosted context and ingestion inputs selected by Fidy; no separate model API is wired.                                                                                              | Record the deployed model and enabled services, current AI-specific terms, request/content retention and any model-specific exceptions. Do not infer inference location or absence of retention from a D1 location hint.                                                      |
| CF-email     | Email Worker receives forwarded financial text/HTML/inline images and privately stages originals for the ingestion purpose.                                                                                        | Verify routing/domain, resources, actual retention configuration and email-service terms. This is distinct from outbound Resend and the support inbox.                                                                                                                        |
| CF-operator  | Cloudflare Access protects recovery and erasure operator applications; operator email and authentication metadata cross this boundary.                                                                             | Verify actual Access identity method, application/audience, authorized operator, logs, identity subprocessors and terms. This is operator data, not authority to read a Titular's content without case review.                                                                |
| K-messaging  | Kapso carries WhatsApp messages, files, delivery metadata and Portfolio/BSUID channel evidence.                                                                                                                    | Identify project, sandbox/production number scope, plan, contracting entity and accepted Terms/DPA; inspect actual history, logs, features and deletion capability. Preserve the Free indefinite-history exception.                                                           |
| K-transcript | Kapso may turn voice messages into text before Fidy receives them.                                                                                                                                                 | Match the current subprocessor list to the actual account's voice route, enabled features, transcript retention and instructions. A listed transcription company is a candidate, not proof that it received Fidy data.                                                        |
| META         | WhatsApp Business Platform transports messages/media and channel metadata independently of Kapso's copies.                                                                                                         | Identify actual business/WABA/number relationship, accepted Platform terms and applicable data terms. Separate on-instruction activity from Meta's own platform/security purposes; do not apply Business App terms automatically.                                             |
| W-billing    | Wompi receives payment enrollment and collection data, billing email, amount/currency, references and payment-source authority. Card/wallet entry is transient; native adapters include card, Nequi and DaviPlata. | Verify merchant entity, sandbox/production and each activated method, actual merchant agreements/acceptances, method-specific recipients, retention and rights route. Source support for a wallet does not prove activation or add its operator as a verified Fidy recipient. |
| G-auth       | Google OIDC `openid email`: provider verification and stable issuer/subject, with optional contact email. Fidy retains no provider tokens and requests no mailbox scope.                                           | Verify actual OAuth application, project owner, consent screen, scopes, callback and applicable identity/API terms; classify independent Google purposes separately. A Workspace DPA is not automatically the consumer OIDC mechanism.                                        |
| MS-auth      | Microsoft common-v2 OIDC supports personal and work/school accounts; tenant-qualified issuer/subject and optional contact claims, no mailbox scope or retained provider tokens.                                    | Verify application registration, owner, audience types, scopes/callback and actual identity terms. Review consumer and organizational flows separately; do not assume an enterprise DPA makes all identity activity processing on Fidy's instructions.                        |
| R-email      | Resend sends authentication, recovery and service email to the intended recipient; no inbound financial mailbox or Resend Receiving is wired.                                                                      | Verify sending account, entity, plan, domain, retained email/log data, recipients and applicable DPA acceptance. A sending-region setting alone is not proof of storage residency.                                                                                            |
| OP-inbox     | The published support inbox receives request correspondence and any approved response.                                                                                                                             | Identify its actual hosting provider, account/entity, retention, trash/archive/backups and contractual rights/incident channels. Do not infer its host from the email address or OIDC provider.                                                                               |
| OP-evidence  | The local restricted case register/evidence stores minimal authority, case, source, response and delivery evidence.                                                                                                | Verify actual storage/backup destinations, permissions, approved finite retention and any third-party service. Existing FileVault/setup evidence is dated #1273 evidence, not proof of a new backup contract.                                                                 |

The fixed anonymous GitHub release-metadata GET sends no User financial payload or User credential;
its [adapter](../../apps/server/src/shell/outbound-http/internal/cli-release-http.ts) restricts release
destinations and redirects. Public installer traffic is separate. Have the reviewer record the
source-consistent applicability decision rather than silently classifying GitHub as a financial-data
processor. Likewise, User-selected agent hosts are distinct User recipients under their own grants;
no Fidy-contracted model provider is inferred from the host's name. Reassess when the actual chain
changes. Bancolombia data access is not introduced by this work.

## Contract and location review

For each flow, the qualified review must identify who decides each purpose and who acts on whose
instructions before classifying responsibility. Record domestic/international transfer or
transmission and the applicable Colombian mechanism using the actual contract and locations.
Provider GDPR SCCs or a DPA title alone do not establish that mechanism. Mark unknown storage,
inference, support access and onward-processing locations separately; no Colombian residency is
verified by this reconciliation.

Record clause references for instructions, confidentiality/security, rights assistance, authorized
subprocessors/change notices, deletion/return, residual retention and incident notification/contact.
If unavailable, record the missing evidence, the owner and the specific account/export/support step
needed. Missing evidence means **unverified**, not that the provider lacks a contract or violates law.
Provider publication updates, account/entity changes, new scopes/features/models/payment methods,
changed locations or retention, a subprocessor change and an actual rights-request conflict reopen
only the affected flow's decision.

## Disclosure comparison

The current [public policy](../../apps/site/src/assets/policy.html) names the six primary providers,
distinguishes outbound and forwarded email, discloses possible foreign processing and Kapso Free
indefinite history. The [chat disclosure](../../apps/server/src/shell/consent/internal/current-disclosure.ts)
pins `onboarding-2026-10-08-providers` and policy `policy-2026-10-09-browser-agents`; the
[web disclosure](../../apps/server/src/shell/consent/internal/web-disclosure.ts) pins
`web-provider-2026-10-09-browser-agents`. No legal bytes, revision, digest or accepted historical
evidence changed in this slice. No approved account finding yet supports a replacement legal copy.

The policy's card-focused payment description must be reconciled with actual wallet activation
before claiming all enabled billing methods are covered. The newer Kapso subprocessor publication
must be compared to the actual transcript route. Separately inspect Kapso's Free feature/model
improvement instruction and Resend's disclosed trust/safety sampling route against the account and
approved purposes. The accepted Kapso retention exception grants no training authorization. No
account preference was inspected or changed here; any verified conflict needs its own explicit
operator/legal decision. Do not name a candidate as Fidy's active processor,
claim finite Kapso expiry, promise completed erasure from a request receipt, promise Colombian
residency or treat a public agreement as accepted. Record any needed copy correction with the
reviewer's approved findings first. Then update the current artifact and metadata/digests together,
retain historical snapshots and run the exact-copy tests below.

## Execution and completion

Use the [provider request procedure](provider-rights-1275.md) with the approved #1273 entitlement and
#1274 erasure decision. It is an execution draft pending per-flow review and available-account
testing. It introduces no new identity checks or provider deletion API. No account test has been
performed for #1275; local native tests do not establish provider completion.

#1275 stays open until every actual active flow has current restricted evidence and qualified review
or a specifically approved, source-consistent applicability decision, the provider deletion/support
boundary is rehearsed using disposable data, and approved findings are reconciled with disclosure.
Do not close it from this inventory, the public research or passing local checks.

Focused verification of the reused boundaries:

```sh
bun run --cwd apps/server test src/shell/consent/current-disclosure.test.ts --coverage.enabled=false
bun run check:policy
bun --bun vitest run --config scripts/vitest.config.ts scripts/titular-erasure/operations.test.ts scripts/titular-requests/runtime.test.ts
```
