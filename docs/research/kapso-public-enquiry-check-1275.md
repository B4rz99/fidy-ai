# Kapso public enquiry check — #1275

Observed **2026-10-16**, America/Bogota. This check narrows the prepared Kapso enquiry before any
provider contact. It uses official public documentation; it does not establish Fidy's contract,
processing history, legal classification or completed erasure. No provider was contacted and no
account configuration was inspected or changed in this research.

## Sources checked

The [Trust & Legal hub](https://kapso.com/trust) links the four current legal documents and publishes
`legal@kap.so` for questions. The [documentation index](https://docs.kapso.ai/llms.txt) was checked for
contact erasure, logs, message events and transcription topics. The relevant pages below and targeted
official-domain searches were reviewed. This is a scoped search, not a claim that every Kapso page
was read. The indexed message-events and call-recording pages failed to load through the research
tool; their content supplies no conclusions here. Calling is distinct from message-audio
transcription and should not be inferred to be enabled for Fidy.

## Already answered publicly

| Question in the earlier enquiry                       | Public answer and implication                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What are the current terms and how are they accepted? | [Terms, version 2026-09-17](https://kapso.com/terms), identify Kapso, Inc. and acceptance through account creation, clicking acceptance, an incorporating order form or service use. Organizational use represents authority to bind that organization. Asking support to repeat this mechanism is unnecessary. The public page does not identify Fidy's actual contracting customer or acceptance event.                                                                                                                   |
| Must a separate DPA be signed?                        | [DPA, version 2026-09-17](https://kapso.com/dpa), introduction, incorporates automatically through terms/agreement or processing service use; a separate signature is unnecessary.                                                                                                                                                                                                                                                                                                                                          |
| What does disabling improvement do?                   | DPA §11 makes the Free default instruction withdrawable through a project control or written notice. Changes are prospective; service, security, abuse, legal and de-identified analytics processing can continue. No promise of undoing prior training is stated. Do not ask whether the opt-out is prospective as though this were undocumented.                                                                                                                                                                          |
| What deletion and assistance obligations exist?       | DPA §§7, 10 and 12 provide tools/assistance, qualified deletion or anonymization, and compliance-information requests. Backup rotation, technical limits and specified retention purposes qualify deletion. No numeric backup cycle or contact-job completion receipt is specified there. [DPA](https://kapso.com/dpa).                                                                                                                                                                                                     |
| When do support vendors receive data?                 | [Subprocessor list, version 2026-10-10-subprocessors, effective 2026-10-11](https://kapso.com/subprocessors), already describes Slack support collaboration, Supabase support-case storage/search and Vercel support-app operation. It identifies relevant case/diagnostic content and typical locations, with location qualifications. Ordinary relationship correspondence alone does not establish the customer-content subprocessor role. A broad question asking when support vendors may receive content is answered. |
| Which audio provider is disclosed?                    | The same [list](https://kapso.com/subprocessors) identifies ElevenLabs for transcription/voice, subject to feature/route applicability. Listing does not establish which route processed a particular Fidy artifact.                                                                                                                                                                                                                                                                                                        |
| How long is history kept?                             | [WhatsApp data](https://docs.kapso.ai/docs/platform/whatsapp-data) describes indefinite default history, including Free. Paid expiry covers ended conversations and linked messages/media/audio transcripts and other listed artifacts; agent transcripts are removed when unreferenced. Contacts and some aggregate records remain; calls are unlinked. These are paid-retention rules, not proof of the contact-erasure job's full scope. The approved Free exception stays intact.                                       |
| What about searchable message logs?                   | The same [page](https://docs.kapso.ai/docs/platform/whatsapp-data) specifies 30 days or the shorter retention window; conversation deletion also removes its log entries. This does not establish every operational/security log's lifetime. It also says audio transcripts carry provider information, making restricted metadata inspection preferable to an unnecessary enquiry.                                                                                                                                         |
| What endpoint and fields erase a contact?             | [Erase contact](https://docs.kapso.ai/api/platform/v1/contacts/erase-contact) documents authenticated `DELETE /platform/v1/whatsapp/contacts/{identifier}`, including contact UUID, and an asynchronous `204` queue acknowledgement. It names contact/conversation/message/media scope. Use an independently reconciled UUID; the parent-BSUID lookup is ambiguous across contacts. No need to ask for the basic endpoint or identifier.                                                                                    |
| Can the contact be checked afterward?                 | [Get contact](https://docs.kapso.ai/api/platform/v1/contacts/get-contact) supplies the authenticated lookup and `404` result. This can contribute to a bounded rehearsal, but absence of that object alone cannot establish disposal of every retained copy.                                                                                                                                                                                                                                                                |

The [Privacy Policy](https://kapso.com/privacy), §§9–11, gives additional public retention detail:
active-system deletion after account/project deletion is typically 30–90 days, qualified by technical,
backup, legal and security requirements. Backup rotation has no numeric cycle there. Logs and
telemetry can last days to months; financial/security/audit records may last longer. Those statements
do not set a contact-erasure completion deadline. The policy publishes `legal@kap.so` and allows
authority verification for requests. Its prospective improvement description does not disclose
whether Fidy's earlier content was actually selected or processed.

The [log-search catalog API](https://docs.kapso.ai/api/platform/v1/log-search/get-log-search-catalog)
can identify project-specific searchable sources and fields. It is not a deletion-completion API or
a universal retention specification.

## Remaining targeted questions

The following were **not established by the checked sources**, rather than proven absent from every
public page. They justify a narrowed enquiry if the corresponding account evidence cannot resolve
them:

1. How can the authorized owner obtain the contracting-customer identity and actual acceptance or
   applicability record/version history for project `fidy`, including delivered updates? Public
   incorporation rules and a notice's delivery do not supply that historical evidence.
2. If restricted account/provider metadata cannot identify it: which provider, route and processing
   locations apply to this project's enabled message-audio transcription? Do not infer every listed
   provider was used, or send an audio message solely to discover this without rehearsal approval.
3. Was any project content actually used for generalized improvement before the recorded opt-out,
   and what prior-content or derived-artifact scope remains? The prospective rule is already known;
   do not ask Kapso to restate it or assume historic training occurred.
4. For a bounded contact-UUID erasure, how can the operator observe job failure/completion and obtain
   scope-specific evidence for audio/agent transcripts, webhook/event/log records, backups and
   subprocessor copies? Which exceptions and expiry/rotation periods apply to residuals? The
   published queue acknowledgement and general retention qualifications do not answer those
   completion questions.

## Narrowed enquiry text

> We have reviewed Kapso's current Terms/DPA, Privacy Policy, subprocessor list, WhatsApp-data and
> contact-erasure documentation. For the Free project named fidy, how can the authorized owner obtain
> its actual contracting-customer and agreement applicability/version record? If the enabled
> message-audio route is not identifiable through account/provider metadata, please identify its
> provider and processing locations. Our improvement preference is disabled; was earlier project
> content actually used for generalized improvement, and what residual prior-content scope remains?
> For a contact-UUID erasure rehearsal, what evidence distinguishes queued, failed and completed
> work, including transcript, webhook/event/log, backup and subprocessor residuals and their expiry?
> This requests information only, without User data or attachments. It authorizes no deletion,
> content access, agreement acceptance, objection, account or plan change.

Support correspondence can itself enter the disclosed support chain. Share only approved company,
business mailbox and project label; keep credentials, subject locators, messages and restricted
evidence out of this capability enquiry. A substantive answer still needs applicability review and
an authorized rehearsal before #1275 can claim a tested provider boundary.
