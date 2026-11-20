# Atomic provider onboarding across owner seams

- **Status:** Accepted
- **Date:** 2026-08-01
- **Amended:** 2026-10-24
- **Related:** [ADR 0020 Provider authentication and recovery](./0020-mandatory-verified-email-authentication-and-recovery.md)

[ADR 0041](0041-per-user-durable-object-storage-direction.md#one-shared-lookup-object)
gives Directory the permanent, single-User proof handoff. Directory reservations route completion
and cannot establish User authority or release an uncertain identity for a second User.

Signup composes the published owner operations in one local UserStore transaction. Provider
Authentication verifies the ProviderPrincipal and binds the ProviderCredential. Identity creates
the stable User and TrialPeriod. Consent appends the exact accepted disclosure and Recovery
installs the BackupRecoveryCode digest. WhatsApp-led completion consumes the exact originating-chat
proof in that transaction. Independent web signup creates neither a WhatsAppIdentity nor a
VerifiedEmailCredential. Failure leaves none of those owner effects committed.

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

## Consent evidence before a User exists

The short disclosure keeps its structured legal facts and the exact text shown to the User. The
pending exchange binds a provider-qualified initiating message and expires at the 24-hour boundary.
It keeps only the initiating provider key and legal exchange evidence. Financial content remains
outside the exchange. A decision must follow proven delivery and use the closed consent grammar.
A bare “sí” is ambiguous. An older message cannot open a replacement exchange after expiry.

The delivery owner generates an unpredictable callback token for each exchange. Its UUID shape
validates representation. Correlation binds the callback to delivery evidence without making
provider ids or tokens reusable User authority.

Processing Consent withdrawal and exact reacceptance append to the current same-User basis.
Operational cleanup removes expired undecided offers, while accepted or rejected legal
evidence stays retained. Original queued work can finish only with its exact unexpired admitted
identity and the owner's remaining guards. Category-specific authority and physical erasure
remain separate. Consent rechecks immediately before egress under User coordination, without
holding a storage transaction open across provider work.
