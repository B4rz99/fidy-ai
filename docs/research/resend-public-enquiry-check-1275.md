# Resend public-document check before enquiry — #1275

Observed **2026-10-16**, America/Bogota. This checks the official public material relevant to the
prepared Resend enquiry. It does not claim every page on Resend's site was reviewed. No provider was
contacted, account setting changed, or data deleted. Account observations remain in the restricted
evidence referenced by [the reconciliation](../operations/provider-reconciliation-1275.md).

## Answers already published

Resend's [GDPR overview](https://resend.com/security/gdpr) supplies these answers, so the enquiry
should not ask for them again:

- Its standard DPA is pre-signed and executed at signup, with no separate countersignature. The
  signed copy is downloadable through authenticated **Documents**. Resend says it does not sign
  country-specific or third-party DPAs; requesting legal-document changes requires Enterprise.
- Stored customer data, including content, delivery logs, webhook payloads and account records, is
  in the **United States**. A sending-domain region controls sending/routing, not storage.
- Free, Pro and Scale email/log retention is **30 days**; Enterprise retention varies. Remaining
  customer data is deleted within **90 days after account termination**. Earlier removal of a
  particular message is available by contacting Resend.
- Ordinary Emails API sending does not send content to Anthropic. AI Editor or chosen AI Support
  Agent content can reach Anthropic. RunPod processes a small sample of emails for trust/safety on
  Resend-operated dedicated infrastructure. Resend says neither it nor those subprocessors trains
  or fine-tunes models on customer content.

The [Security overview](https://resend.com/security) separately describes point-in-time backups
persisting **seven days** and links the signed DPA and security reports through Documents. That
general backup window is not a per-message deletion receipt or proof that every independent
security/support record expires with the email.

The [DPA](https://resend.com/legal/dpa), updated **2025-12-31**, binds through the customer's
Agreement or execution. Its published exporter entry refers to the customer specified in that
Agreement; it does not identify FIDY S.A.S. Sections 2.4 and 7 provide qualified deletion/return and
rights assistance. Legally retained or impracticable-to-destroy copies remain protected and blocked
from further processing subject to the stated exceptions. SCC deletion certification is available
on request where applicable; it is not an unconditional per-email completion API. Section 8.3
requires DPA compliance records for three years after termination. Sections 8.6–8.8 qualify breach
notification and assistance. Section 9 treats account/usage processing separately as independent
controller activity. Exhibit B names **privacy@resend.com** as Resend Security's contact.

The [Privacy Policy](https://resend.com/legal/privacy-policy), updated **2026-08-27**, publishes
**support@resend.com** for access/removal requests and allows identity verification. Account/usage
retention depends on purpose and legal obligations, disputes, agreement enforcement and certain
security/functionality uses; it gives no universal fixed expiry for those records. These controller
exceptions must not be replaced with the ordinary email-retention window.

The [Terms](https://resend.com/legal/terms-of-service), updated **2026-08-27**, identify Plus Five
Five, Inc. They describe acceptance by use, updated terms through continued use, and accurate current
account information. They publish **support@resend.com** for technical support. These rules explain
the public acceptance mechanism, not the historical identity or acceptance record for team fidyapp.

## Sending, Receiving, events and deletion boundaries

The [pricing table](https://resend.com/pricing) places the standard 30-day retention in its
**Sending & receiving** section. It does not provide a field-by-field schedule for every received
attachment, webhook delivery attempt, trust/safety sample or support record.

[Managing received emails](https://resend.com/docs/dashboard/receiving/manage-emails) documents
stored content, metadata, raw/HTML/plain text, attachments and replay after webhook failure. It
does not document an early single-message erase action. The
[Receiving API reference](https://resend.com/docs/api-reference/emails/retrieve-received-email)
documents retrieval; the standard Sending/Receiving navigation lists no message-erasure endpoint.
This is a bounded documentation observation, not proof that no private/account capability exists.

[Managing sent emails](https://resend.com/docs/dashboard/emails/manage-emails) describes viewing,
events, sharing, logs and exports. A delivered status concerns acceptance by the recipient's mail
server. Its export links last seven days; deleting an email from Resend would not remove copies
already downloaded by a customer or delivered to a recipient. The
[Cancel Email API](https://resend.com/docs/api-reference/emails/cancel-email) cancels a scheduled
send; it is not an erasure endpoint for delivered content.

There **is** a separate private-beta
[Delete Thread API](https://resend.com/docs/api-reference/inboxes/delete-thread): it moves a thread
to trash and schedules deletion in 30 days, with restoration clearing that deadline. Its
`deleted: true` response means moved to trash. The
[Delete Inbox API](https://resend.com/docs/api-reference/inboxes/delete-inbox) removes an inbox but
does not specify erasure of all residual copies. Neither establishes that Fidy uses the Inboxes
beta or provides a substitute for narrowly scoped Sending/Receiving erasure. Do not delete a shared
inbox for a single Titular request.

[API logs](https://resend.com/docs/dashboard/logs/introduction) can contain full request and response
bodies and link to email records. Do not assume content erasure automatically removes associated
logs. [Webhook retries](https://resend.com/docs/webhooks/retries-and-replays) have a documented
backoff schedule and manual replay. Disabling an endpoint stops delivery attempts; the page does
not say this deletes already retained payloads or recipient-side copies.

## Subprocessors and contacts

The [subprocessor list](https://resend.com/legal/subprocessors), updated **2026-08-27**, gives US
locations and purposes: AWS hosting/sending, PlanetScale database, Svix webhooks, Plain support,
RunPod self-hosted LLMs and other operational providers. The list describes potential provider
involvement; it neither proves that a specific Fidy email was sampled nor that every listed party
received it. No individual-sample lookup or sample-specific erasure receipt was established in the
checked material.

The [Support page](https://resend.com/support) supplies its contact route and support hours. The
[Responsible Disclosure page](https://resend.com/security/responsible-disclosure) is for vulnerability
reporting. There is no need to ask Resend for a generic rights or incident contact already published.

## Narrow questions still justified

The general published DPA download procedure is already known and the account copy was inspected.
The remaining evidence question is **which customer entity, effective acceptance date and
agreement/version are recorded for fidyapp**, and where the operator can retrieve that
account-specific record. A blank customer field in a standard provider-signed PDF neither proves
absence of a contract nor establishes that the customer is FIDY S.A.S.

The checked sources direct early message deletion to support but do not establish its minimum
authenticated intake fields, per-class completion evidence, or the treatment of linked attachments,
delivery/webhook payloads and attempts, trust/safety samples and downstream copies for one bounded
message request. These are appropriate capability questions. Ask which exceptions and expiry apply
to that scope rather than asking Resend to restate its standard retention/location pages.

Recommended enquiry to **support@resend.com** from the authorized business mailbox:

> We are reviewing Resend team fidyapp for FIDY S.A.S. We have downloaded the standard signed DPA
> through Documents and read your public retention, US-storage and subprocessor disclosures. Where
> can we obtain the account's recorded contracting-customer identity, effective acceptance date and
> applicable Agreement/DPA version? For the early removal of one disposable test email owned by us,
> what minimum identifiers and authenticated verification do you require before any deletion
> instruction? How do you report completion versus retained scope for content/attachments, linked
> delivery/API logs, webhook payloads/attempts and any trust/safety sample or subprocessor copies?
> Please identify the specific exclusions and expiry applicable to such a request. This is a
> capability enquiry only: no deletion, account closure, agreement/configuration change, purchase or
> access to User content is authorized.

No email body, recipient list, attachment, token, raw account evidence or actual provider message ID
is needed for this first enquiry. If Resend requires any of those, prepare the exact requested scope
before sharing. A response describing the process still does not establish execution or completed
deletion. Colombia-specific applicability remains a qualified review decision, not a provider
marketing claim or a requested rewrite of Resend's standard DPA.

## Search coverage and limitations

Checked the linked Terms, DPA, Privacy Policy, GDPR, Security, subprocessors, pricing, support,
vulnerability reporting, sending/receiving management, API logs, cancellation, Receiving API,
Inboxes deletion and webhook retries pages. Used the official
[documentation index](https://resend.com/docs/llms.txt) to identify relevant capabilities and searched
official Resend pages for retention, deletion, receiving and signed-account documents. An assumed
`/docs/knowledge-base/email-data-retention` URL did not resolve and supplies no evidence. Search
results for the signed PDF contained an older indexed date; use the previously retained actual PDF
and current public DPA separately rather than substituting a search snippet for either.

Public-document research cannot expose Fidy's private historical acceptance record or prove an
actual erasure result. Recheck the public sources if the enquiry is delayed or account services
change. This note narrows the enquiry; it does not close #1275.
