# Privacy accountability and incident decisions — #1276

Version 1, prepared 2026-10-16. **Implementation in progress; not legal sign-off, a live incident
report or bank acceptance.** This procedure consumes the technical response in
[security response](security-response.md) and the detection/operational work in
[#1262](https://github.com/B4rz99/fidy-ai/issues/1262). It introduces no detector, incident API,
production access, reporting automation or new identity mechanism.

The [applicability record](privacy-applicability-1276.md) owns RNBD inputs, recipient-specific
reporting rules, public-channel verification and the bank evidence index. Its
[official-source research](../research/privacy-reporting-public-evidence-1276.md) records versions,
clause references, statutory timing and unresolved interpretations.

## Accountable function

Orlando Barboza, through `obarboza@fidyapp.com`, is the existing sole operator and the privacy
decision owner for this implementation. This carries forward the operator arrangement approved in
[#1273](titular-requests-1273.md); it does not claim an independently verified appointment by the
company. The owner coordinates Titular cases, provider evidence, assessment, decision review,
authorized communications and follow-up. The legal reviewer decides applicability; a technical
responder supplies observations and containment evidence, not a legal verdict. At MVP scale the
same operator can perform the technical and privacy functions while recording each decision.

There is **no backup person**, delegated access or retained external counsel established by this
record. Do not invent a second responder or disclose credentials to obtain one. The escalation
path for a legal question is the owner's selected qualified Colombian reviewer, recorded privately
before engagement; no person or availability is assumed. Provider containment follows the existing
verified account/security channel. A provider or reviewer cannot file on Fidy's behalf without the
corresponding authority.

If the owner is unavailable, preserve the original detection and notice times and mark the decision
**Unresolved / owner unavailable**. Existing fail-closed controls remain in force; this procedure
does not automatically disable a service or authorize a new deployment. Any already authorized
technical responder uses only the existing containment procedure. With no such responder, record
that containment and a deadline may be missed. Do not claim continuous coverage, postpone a legal
clock until the owner returns or classify absence of a decision as non-reportable. On return, the
owner immediately reviews elapsed targets, seeks qualified advice and documents any late action.
Before relying on this as an effective unattended response arrangement, the owner must establish
and rehearse a reachable escalation recipient or explicitly resolve that operational gap.

## Restricted decision record

Keep records under the existing encrypted, operator-owned evidence directory outside Git, as used
by [provider reconciliation](provider-reconciliation-1275.md). Verify directory ownership and mode
0700 and file mode 0600; do not follow links or overwrite an original observation. Access is limited
to the owner and an explicitly authorized reviewer. No shared mailbox access, cloud backup or
reviewer access is granted by this document. Record backup destinations before copying evidence.

Use a fresh opaque UUID for each incident, source artifact, decision revision and exercise result.
Append a new decision version with its predecessor rather than editing a submitted report or
earlier conclusion. An opaque reference addresses evidence; it does not prove that evidence exists.
Use one local restricted JSON or Markdown record with the following fields; no new software is
needed to operate this procedure:

| Field                  | Required evidence                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and custody   | Incident UUID, version, previous decision reference, actual operator/entity evidence reference, accountable owner and access list.                                                                                      |
| Separate clocks        | Event start/end if known, detection UTC instant, when the responsible function learned of it, provider notice receipt, containment and decision instants. Preserve originals and uncertainty.                           |
| Technical handoff      | Exact revision/service, observation and authorized evidence references from #1262, affected data categories and bounded subject estimate, access/integrity/availability facts and unknowns. No secrets or raw payloads. |
| Applicability          | Fidy's role for this flow, applicable regime, RNBD decision reference, recipient-specific source/contract version and reviewer identity/qualification/date. Unknown is explicit.                                        |
| Timing                 | Trigger, source clause, clock start and why, calendar/time zone, deadline rule, worked calculation, uncertainty, earlier internal target and next review. Detection and notice clocks cannot be silently reset.         |
| Decision per recipient | SIC, institution, provider/controller and affected people considered separately: Reportable, NonReportable or Unresolved; facts, source and rationale for each. A generic yes/no cannot cover every recipient.          |
| Communication          | Minimum necessary unsent draft, actual approved recipient/channel, approver and scope, sent instant, receipt/reference, delivery failure and correction/update linkage. Draft, submitted and received are distinct.     |
| Follow-up and closure  | Containment status, residual impact/unknowns, next action/owner/due instant, report updates, restoration proof, reviewed retention purpose/end condition and disposal/hold evidence.                                    |

Keep personal identifiers, confidential company accounts/financials, detailed legal advice and any
strictly necessary affected-person mapping in separate restricted artifacts. The decision metadata
contains only their references and minimized categories/counts. Credentials, OTPs, bank/card details,
full financial records, prompts and provider bodies are not incident-record attachments by default.
Collect neither a broad production export nor request-body logs to make the record look complete.

For an actual incident, the reviewer must set a source-backed retention duration or objective end
condition, review date, authorized readers and terminal disposition. A pending investigation does
not authorize indefinite retention: record a finite next review and a justified hold where needed.
Missing retention approval is an open decision, not permission to destroy unresolved evidence.
Synthetic training records contain no real affected people; review them after 30 days and retain
only the minimum exercise evidence for an explicitly recorded finite period. No automatic evidence
purge is performed by this procedure.

## Assessment and response

1. **Receive and preserve.** Open a restricted record immediately from the technical alert or a
   provider notice. Preserve its original times and source. Authenticate a provider notice through
   a known account/channel without following an email's credential or upload instructions. A
   provider allegation is evidence to assess, not proof Fidy data was affected.
2. **Contain through the technical owner.** Invoke the existing security-response procedure with
   its scoped authority. Preserve required evidence without delaying safe containment. A green
   health check, rejected login or corrected release does not by itself prove no personal-data
   exposure. Keep containment, erasure and legal-reporting authority separate.
3. **Assess impact and applicable clocks.** Determine what is observed, inferred and unknown;
   consider confidentiality, integrity and availability. Record controller/processor roles per
   purpose and each reporting recipient independently. Start a conservative internal target from
   the earliest plausible trigger while the qualified reviewer resolves ambiguity; never wait for
   a forensic final report or a bank response before evaluating the applicable clock.
4. **Decide and prepare.** Record Reportable, NonReportable or Unresolved per recipient, with
   reviewer, source and timing. NonReportable requires affirmative scoped evidence and a reopening
   trigger. Unresolved requires a named next action and time, not a claim of no impact. Prepare a
   minimum initial notice with known facts and explicitly bounded unknowns; get reviewed advice on
   a timely initial submission if the applicable duty is established but scope is incomplete.
5. **Submit only the approved actual notice.** Check the current official/authenticated channel,
   exact recipient, authority and minimum required fields. An exercise never files a live incident
   or contacts third parties. A real external report or sensitive disclosure needs explicit
   approval for its actual facts and recipient. Preserve the submitted version and receipt; a
   failed channel keeps delivery unresolved and triggers immediate channel/escalation review.
6. **Update and close separately.** Reassess after new facts, provider updates, scope changes or
   corrected earlier statements. Link updates to the same authority/case reference without
   rewriting the initial notice. Close only after the technical disposition, each notification
   outcome, remaining holds, review dates and accountable follow-ups are recorded. A pending
   provider response or notification cannot disappear because technical recovery finished.

## Decision and training evidence

The [tabletop](privacy-tabletop-1276.md) exercises this procedure with fictional facts. It must
identify the actual facilitator/reviewer, exercise time, source versions, scenario facts,
independent reasoning, draft notices, outcomes and gaps. Assistant execution or code review is not
operator training or qualified Colombian legal approval. Store actual decision/training records
privately; public status contains safe references and limitations only.

## Completion evidence

Keep #1276 open until verified entity/asset facts support a dated RNBD decision by a qualified
reviewer; the reporting rules/contacts and owner/escalation arrangement are reviewed; the synthetic
exercise has traceable reviewed outcomes; and the bank evidence index accurately reflects them.
Existing #1273 approval does not automatically approve these new determinations. Neither provider
acceptance in #1275 nor technical alert delivery closes these requirements.
