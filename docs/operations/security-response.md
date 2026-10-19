# Security incident response

Repository procedure established by #1260. The [2026-10-19 bounded drill](security-drill-1276.md#resumption--2026-10-19)
records scheduled alert receipt/resolution and synthetic PAT containment/cleanup, with explicit
detection and acknowledgement limits.
Use with [production recovery](production-recovery.md) and
[background-work monitoring](cloudflare-background-work.md).
This procedure does not widen production access, permit destructive recovery, or enable MCP launch.

Use [privacy decisions](privacy-decisions-1276.md) for the separate privacy assessment, RNBD
applicability and recipient-specific reporting decision. It consumes this technical handoff and
#1262's actual evidence; a privacy tabletop does not verify technical detection or live response.

## Ownership and detection

The sole Production operator owns triage, containment, recovery and the restricted incident record.
Use the existing response targets: investigate critical conditions within 30 minutes and warnings
within one Bogota working day. If the operator cannot respond, keep affected capabilities closed
through reviewed release changes; do not assume a second responder exists.

| Signal                                                                      | Evidence and limitation                                                                                                                                                                            | Initial response                                                                                                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suspected cross-User access, unauthorized mutation or credential disclosure | Canonical metadata-only Audit, credential lifecycle evidence and exact deployed revision; missing evidence is uncertainty, not proof of no access                                                  | Critical: identify affected authority and stop further use through its existing revocation/control owner                                          |
| Repeated authentication, authorization or callback rejection                | Native Cloudflare metrics and the bounded Core HTTP/callback/MCP concentrated-refusal warning described in the background-work runbook; distributed/edge and some protocol abuse remain unobserved | Inspect the affected route, aggregate period and rate admission; do not enable request-body or credential capture                                 |
| Unexpected model/tool behavior or poisoned context                          | Same-User operation outcomes, bounded Turn lifecycle and the exact model/configuration revision                                                                                                    | Check whether independent authorization/confirmation held; suspend the affected capability through a reviewed release if containment is uncertain |
| Failed Workflows, dead letters, unavailable inspection or overdue retention | Existing private operational-health signals and operator notification state                                                                                                                        | Follow the owning background-work recovery procedure; receipt must be confirmed independently of provider send acceptance                         |
| Vulnerable dependency or compromised build input                            | SCA/secret/SAST job and immutable dependency/action/image identity                                                                                                                                 | Stop promotion of the affected candidate, revoke exposed authority if needed and fix through reviewed dependency/release gates                    |

The Core warning detects concentrated HTTP, callback and MCP canonical refusals within each
HTTP assembly or User coordinator residency; it is not a complete
security-event correlation service. Distributed, edge and other protocol/status abuse detection remain explicit
outstanding requirements tracked in [#1262](https://github.com/B4rz99/fidy-ai/issues/1262). Manual inspection does not close those requirements.

## Triage and containment

1. Open a restricted incident record with UTC detection time, severity, affected surface, exact
   source/deployment/model versions, observed outcome and an evidence reference. Keep raw credentials,
   User identifiers, financial content, prompts, tool arguments and provider bodies out of GitHub
   issues, this repository and ordinary logs. Public engineering tickets contain only sanitized facts.
2. Establish the affected authority: WebSession, PAT, OAuthConnection, provider credential, hosted
   Turn, build/deployment credential or provider callback. Do not infer User identity from an IP,
   email address, tool argument or provider-returned contact field.
3. Use the existing owner-authorized revocation or provider credential-rotation procedure. Browser
   logout, PAT revocation and OAuth revocation are independent; do not claim one revokes the others.
   No generic cross-User admin revocation endpoint is created by this procedure. If existing safe
   authority cannot contain the incident, use a reviewed release change and the protected Production
   controller; never manufacture a SQL repair or reuse the incident-specific deleted-Queue override.
4. Preserve only necessary metadata and restricted evidence for the approved purpose and retention
   period. Do not overwrite append-only Audit/Consent or retain sensitive content indefinitely under
   an informal incident exception. Determine the affected period and Users through authorized access.
5. Assess required provider, User and legal notifications with the responsible operator/legal owner.
   Record the decision and its deadline in the restricted record; a code review cannot decide legal
   notification obligations or prove a notification was received.

## Eradication and recovery

Fix the demonstrated path with a negative test proving refusal and no unauthorized partial effects.
Run affected security and release gates. Use guarded code rollback only when its binding/state
compatibility conditions hold; it cannot undo data exposure, payments, messages, credential issuance,
D1 migrations or provider effects. Reconcile ambiguous effects through their owner rather than
replaying them. Confirm the exact release, restored authorization, stale credential refusal, alert
receipt and affected retention lifecycle before restoring the capability.

Close the restricted record only after recording cause, scope, containment, corrective commit,
verification results, notification disposition and any follow-up owner/deadline. A green health route
or resolved notification row alone does not establish recovery.

## Exercise and evidence still required

Before treating this procedure as operationally verified, the operator must complete a bounded,
authorized exercise using synthetic identities and approved spend/contact destinations. Record:

- exact revision/configuration and UTC start/end;
- injection of one synthetic security condition without real User data or provider effects;
- detection source, receipt and acknowledgement times, with a restricted evidence reference;
- correct scoped containment, including refusal of stale authority;
- recovery through the existing controller and evidence that unrelated authority remains intact;
- notification decision, cleanup, retention and unresolved failures.

Use the existing **Test operator alert email** workflow only within that authorized exercise;
this documentation change does not send an email or perform production fault injection. A tabletop
walkthrough verifies procedure clarity, not deployed alert delivery. Until actual evidence is retained,
Web A09 and MCP08 remain partial.

The procedure follows the separation of security accountability, operational diagnostics and excluded
sensitive data in [OWASP's Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).
