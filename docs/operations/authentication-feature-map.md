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
