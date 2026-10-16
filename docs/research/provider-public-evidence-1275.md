# Provider public evidence for #1275

Observed: **2026-10-15**. Research version: **1**. Scope: official public sources for the services in
[the provider inventory](../operations/provider-inventory.md). This is source research, not qualified
legal review, actual-account inspection, contract acceptance, or a deletion rehearsal. No provider
was contacted and no data was deleted. Published versions below are not evidence of the versions
accepted by FIDY S.A.S.

## Cloudflare

The published [customer DPA](https://www.cloudflare.com/cloudflare-customer-dpa/) is **v6.4, effective
2026-04-03**. It applies to processing on the customer's behalf, distinguishes controller/processor
roles, and includes instructions, personnel confidentiality, security, breach notification, rights
assistance, subprocessing and return/deletion obligations. Its effective date for a customer depends
on agreement. Its transfer provisions are conditional on the laws and flows involved; publication
does not establish Fidy's Colombian legal mechanism or account acceptance.

The [service subprocessor list](https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/)
was labelled **2025-10-01** when observed and identifies service-specific providers and locations,
including international support and Workers AI processing. This is not a Colombian residency promise
or proof every listed provider receives Fidy data.

[Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/) says
Cloudflare does not use Customer Content for model training or service improvement without explicit
consent. Content can remain in storage services the customer uses with AI; model licences are separate.
This does not establish deletion from Fidy's D1, R2, Durable Objects, logs or backups.

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) retains recovery points
for up to **30 days on Workers Paid / 7 days on Free**; restoring does not delete older bookmarks.
Exports to R2 can outlive that window. Review the actual plan and export jobs. Use Fidy's existing
Titular-erasure and restore procedure for User-scoped records; do not delete a shared database or
account. A disposable test must separately observe primary storage, queued work and retained copies.

## Kapso and WhatsApp / Meta

Published [Terms](https://kapso.com/terms) and [DPA](https://kapso.com/dpa) are **2026-09-17**.
The DPA describes automatic incorporation through agreement/use, customer instructions,
confidentiality, security, incident notification and rights assistance. It distinguishes processing
on behalf of customers from Kapso's independent account/billing processing, permits international
processing including the US and Chile, and qualifies deletion by backups, law, security, disputes,
financial/audit needs and technical limits.

**Separate configuration question:** DPA §11 says Free projects default to a customer instruction
for Kapso feature/model improvement, withdrawable prospectively through account controls or written
notice. This is separate from the accepted Free indefinite-history MVP exception. Inspect the actual
project preference and accepted instructions; do not claim that accepting indefinite retention also
approved training, or that an opt-out erases previous training.
This instruction concerns Kapso's own features/models. The same section separately qualifies
authorization for AI subprocessors' general-model training; it is not a blanket statement that all
downstream providers train on Fidy content.

The [subprocessor list](https://kapso.com/subprocessors) now identifies **version
2026-10-10-subprocessors, published/effective 2026-10-11**. The previous repository observation of a
September list is historical. Shared infrastructure includes hosting, databases, object storage,
diagnostics and support. **ElevenLabs** is listed for transcription/voice; model, connected-app,
search and telephony entries apply only to selected routes. The list alone does not identify the
actual provider for a Fidy audio message. Obtain restricted route/configuration evidence and relevant
message provider metadata using disposable audio. Listed locations are typical, not exclusive.

[WhatsApp data](https://docs.kapso.ai/docs/platform/whatsapp-data) confirms indefinite default history
and Free projects keeping everything. Paid conversation retention excludes contacts and broadcasts;
calls are unlinked rather than deleted. Message logs have a separate bounded window. Automatic audio
transcripts include provider information. The accepted Free MVP exception remains unchanged; this
research does not reopen #713 or require an upgrade.

[Erase contact](https://docs.kapso.ai/api/platform/v1/contacts/erase-contact) accepts a contact UUID,
E.164 number or BSUID. **204 means queued**, not completed. Its identifier documentation warns that
a parent BSUID can be shared and the newest match is returned; it does not explain that wording for
an asynchronous DELETE. Avoid that ambiguity: use an independently reconciled contact UUID in the correct project for
a disposable rehearsal. Check disappearance of contact, conversations, messages and media separately;
obtain confirmation of transcript, logs, webhook, backup and subprocessor scope. An API claim or 404
alone does not verify every residual copy. Keep contact identifiers and results restricted.

[WhatsApp Platform Terms](https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-Platform)
are effective **2026-09-23**, and differ from Business App terms. They incorporate Meta terms and
describe own-purpose usage, diagnostic and account processing, global transfers, and up to 90 days'
account data retention on termination with backup copies potentially remaining. The older
[Business Data Processing Terms](https://www.whatsapp.com/legal/business-data-processing-terms)
apply only where the governing Business Terms designate processor processing. Review the actual
Platform route and incorporated Meta agreement; neither Kapso's DPA nor those conditional terms
classify every Meta activity as processing solely on Fidy's instructions. Do not terminate a shared
WhatsApp account to satisfy one Titular request.

## Resend

Published [Terms](https://resend.com/legal/terms-of-service) are dated **2026-08-27** and identify
Plus Five Five, Inc. The [DPA](https://resend.com/legal/dpa), labelled **2025-12-31**, generally makes
Resend processor for customer content but independent controller for account/usage data. It covers
instructions, confidentiality/security, subprocessors, rights assistance and incident notification;
completion/termination deletion is qualified by lawful retention, and Exhibit A describes deletion
within 90 days after account termination. Those are not per-message deletion guarantees.

[Resend's GDPR page](https://resend.com/security/gdpr) says the standard DPA is executed at signup and
downloadable from the authenticated Documents page. It states stored customer data is in the **US**;
a sending domain's region controls routing, not storage. Email/log retention is 30 days for
Free/Pro/Scale; Enterprise differs. Capture the actual account, plan and accepted document. EU SCCs
and DPF statements are not by themselves a Colombian applicability decision.
The page states backups persist seven days and directs early individual-message removal to support.
It also distinguishes AI routes: ordinary Emails API sending does not send content to Anthropic,
while RunPod processes a small email sample for trust/safety on dedicated infrastructure operated by
Resend. These are provider subprocessing disclosures, not additional direct Fidy integrations or
proof that a particular email was sampled.

The [subprocessor list](https://resend.com/legal/subprocessors), dated **2026-08-27**, includes
hosting/sending, storage, diagnostics, support, AI and webhook vendors. A listed webhook service does
not imply Fidy enabled inbound mail or Resend Receiving. Investigate actual service scope without
adding these as direct Fidy integrations.

For a provider-assisted request, prepare the account/domain, exact provider email IDs, bounded time
range and requested content/metadata scope in restricted evidence; ask which retained copies and
exceptions remain and how completion is confirmed. These are proposed minimization fields, not a
verified provider intake schema. Resend's [privacy policy](https://resend.com/legal/privacy-policy)
publishes **support@resend.com** for access/removal requests. A sent request or support acknowledgement
is not proof of deletion, nor does removing Resend's copy remove a recipient mailbox copy.

## Wompi Colombia

The [Colombia merchant rules page](https://wompi.co/es/co/reglamento-comercios/) labels its published
rules **September 2026**. Retrieve the actual merchant's accepted document and payment-service scope;
the public page is not an acceptance record. The [Colombia privacy hub](https://wompi.co/es/co/tratamiento-datos-personales)
separately exposes supplier authorizations: those must not be mistaken for Fidy's merchant agreement.

The official [privacy policy PDF](https://wompi.com/assets/downloadble/Politica-de-privacidad.pdf)
identifies **WOMPI S.A.S., Medellín, Colombia** on page 1 and says approved/effective **2019-03-06** on
page 10. Its availability today does not prove it is the merchant's current accepted policy. It
describes Wompi as responsible for its databases, allows national/international transfers and
transmissions, provides access/correction/suppression procedures, and excludes suppression where
legal/contractual duties require continued retention. It publishes **ayuda@wompi.co** and its web
request channel. No fixed all-record deletion period was established by this research. Obtain
purpose-specific classification and retention evidence for tokenization, billing, fraud and legally
retained transaction records; do not label all Wompi flows processor transmissions or domestic storage.

For an authorized provider request, first reconcile the exact merchant/environment and existing
Wompi transaction/payment-source references, then ask support what minimal verified identifiers and
representation it requires. Do not send card numbers, CVCs, secrets or raw unrelated histories. These
preparation fields are not a tested Wompi erasure API. Unlinking a payment source or stopping billing
is not proof that Wompi deleted financial/legal records.

## Google and Microsoft authentication

[Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies) explicitly
cover authentication-only OIDC. The [User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
covers Google Sign-In and requires transparent disclosed uses. [OIDC documentation](https://developers.google.com/identity/openid-connect/openid-connect)
distinguishes stable subject identity from email. Fidy's inventory is `openid email` only, without
mailbox access or retained provider tokens. Capture the actual OAuth application/account and terms;
do not import Google Cloud/Workspace enterprise DPA coverage merely because the issuer is Google.

[Microsoft Identity Platform Terms](https://learn.microsoft.com/en-us/legal/microsoft-identity-platform/terms-of-use)
require Fidy privacy/retention/deletion controls and expressly say the agreement creates no
processor-subprocessor or joint-controller relationship (§8.5). Additional API terms can apply.
Personal Microsoft accounts and organizational tenant identities require distinct applicability
review; registering a common-v2 application does not prove enterprise DPA coverage for every login.

For both, delete Fidy's own identity links under the reviewed erasure procedure, using the verified
issuer/subject linkage. That does not delete the person's Google/Microsoft account, identity-provider
logs or an employer tenant's records. No provider-wide subject erasure API or tested exceptional
support path is established here. Do not ask the User to close an unrelated identity account.

## What this evidence cannot close

The owner for obtaining missing actual-account evidence is **obarboza@fidyapp.com**. The next step is
to bind each active service to its restricted account/contract/configuration evidence and a dated,
qualified per-flow review: purpose/classes, role, domestic/international transfer or transmission,
applicable mechanism, countries/access uncertainty, retention, rights and incident route. Record
reviewer, document/version, decision and change trigger. Public publication does not establish those
decisions or prove a contract is missing or defective.

Recheck on provider document/route/plan/subprocessor changes and before approving revised public
disclosure. Use disposable data for any authorized deletion rehearsal and record accepted, completed,
retained and unresolved scope separately. Preserve restricted account evidence outside Git; public
status may link only safe references. #1275 cannot be completed by this research note alone.
