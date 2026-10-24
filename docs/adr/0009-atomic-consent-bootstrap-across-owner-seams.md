# Atomic provider onboarding across owner seams

- **Status:** Accepted
- **Date:** 2026-08-01
- **Amended:** 2026-10-24
- **Related:** [ADR 0020 Provider authentication and recovery](./0020-mandatory-verified-email-authentication-and-recovery.md)

Provider signup composes published owner operations in one Cloudflare D1 atomic unit. Provider
Authentication verifies the ProviderPrincipal and binds the ProviderCredential; Identity creates the
stable User and TrialPeriod; Consent appends the exact accepted disclosure evidence; Recovery
installs the BackupRecoveryCode digest. WhatsApp-led completion also consumes its versioned Consent proof
and short-lived invitation or accepted-chat handoff and creates the WhatsAppIdentity only after exact originating-chat confirmation.
Independent web signup creates no WhatsAppIdentity or VerifiedEmailCredential.

Before completion, only bounded pre-User decision and provider-attempt state exists. Those states
are consumed together with the owner results: a failure rolls everything back. A Durable Object may
serialize admission, but cannot replace the D1 atomic boundary. Consent acceptance alone creates no
User, and provider contact email creates no mailbox authority. ADR 0020 supersedes the former
mandatory mailbox-proof bootstrap.

This narrow bootstrap exception does not permit general cross-owner table writes. Owner lifecycles
remain independent; eventual consistency or compensation would leave partially established
identity, Consent, provider authority or recovery evidence.

## Link-first WhatsApp onboarding (#1531)

A first signed message creates only a bounded signup invitation. The first-party browser records
current Consent and verifies Google/Microsoft; neither an opened reference nor browser review
approves channel association. A prepared message names the selected provider account and one-use
review. Sending that exact message from the originating authenticated chat proves the other side.
The completion unit rechecks its exact attempt, private browser pairing, caller, business endpoint,
freshness and native decision before initial association. Provider retries invalidate earlier reviews.
The original page retains private proof while WhatsApp opens separately; no private verifier or
recovery code enters the return link. This simplifies interaction without removing either proof.
