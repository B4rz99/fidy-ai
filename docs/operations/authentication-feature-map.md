# Authentication integration

The [signup and browser login feature map](../../apps/web/src/features/provider-authentication/FEATURE.md)
lives beside the browser feature. It records supported actions, runtime owners, repeatable checks,
current Production evidence and remaining live checks.

[ADR 0020](../adr/0020-mandatory-verified-email-authentication-and-recovery.md) defines provider
signup/login. Provider contact email creates no mailbox authority. Superseded mailbox-code signup,
its Queue/Workflow and browser page are retired; optional mailbox authentication/replacement
remains independently owned. Immutable applied migration history is preserved.

Provider setup and live procedures: [Google](google-authentication.md),
[Microsoft](microsoft-authentication.md), and [support recovery](support-recovery.md).
Local fixtures do not establish live provider or Production readiness.
