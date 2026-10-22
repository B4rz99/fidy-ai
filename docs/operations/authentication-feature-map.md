# Authentication integration

The [signup and browser login feature map](../../apps/web/src/features/provider-authentication/FEATURE.md)
lives beside the browser feature. It records supported actions, runtime owners, repeatable checks,
current Production evidence and remaining live checks.

[ADR 0020](../adr/0020-mandatory-verified-email-authentication-and-recovery.md) defines provider
signup/login. Provider contact email creates no mailbox authority. Superseded mailbox-code signup,
its Queue/Workflow and browser page are retired; optional mailbox authentication/replacement
remains independently owned. The target schema uses one baseline migration; existing databases follow
the explicit [cutover contracts](database-cutover-1428.md).

Provider setup and live procedures: [Google](google-authentication.md),
[Microsoft](microsoft-authentication.md), and [support recovery](support-recovery.md).
Local fixtures do not establish live provider or Production readiness.

### Pairing-to-session authority (#1443)

Browser Login owns approval and private-verifier consumption; WebSession owns the issued bearer and
its independent fresh, idle and hard deadlines. Proof consumption and exactly one same-User session
installation commit in one native D1 batch. A declined or zero-row session write rolls the pairing
back to ready. A consumed pairing cannot reissue a bearer after a lost response; start a new pairing.
Provider, WhatsApp, email and recovery approvals do not themselves create browser authority.

The accepted pairing/session fields and state-owned email dispatch facts remain intact. The only
schema additions are the expiry index for the existing bounded cleanup and an owner index for
User-scoped session erasure, preserving references from sessions and recovery cases. See the [#1443 installation procedure](database-cutover-1428.md#browser-pairing-to-session-authority-1443).

### Provider onboarding ownership (#1444)

Google and Microsoft onboarding use the extracted recovery credential and normalized Consent
history in the same batch as User, original trial, provider association and pairing approval.
Completion checks require those records before disclosing recovery material. Returning login uses
exact issuer/subject and preserves the User's creation and trial facts. Provider contact email
never creates verified-mailbox authority or merges identities.

Established provider credentials and completed attempt evidence are immutable while retained;
purpose-specific erasure and bounded attempt expiry remain available. The five- and eighteen-field
records remain intact. See the [populated guard installation](database-cutover-1428.md#provider-onboarding-ownership-1444).

### WhatsApp-to-browser handoff (#1445)

The original accepted pre-User Consent exchange supplies recipient and disclosure authority.
A separate thirteen-field handoff binds one browser and records send/review/decision/consumption
facts. Confirmations require the originating authenticated chat, the exact review message and a
later eligible reply. Ambiguous review delivery does not authorize sending the review again.

Provider completion and checked handoff consumption now commit together in application-owned D1
statements. A zero-row consumption rolls back signup and association; it cannot leave a completed
attempt with unused confirmation. Claimed browser/review bindings and recorded decision evidence
cannot be rewritten. Independent browser proof remains necessary to obtain a WebSession. See the
[synchronized cutover](database-cutover-1428.md#whatsapp-to-browser-handoff-1445).
