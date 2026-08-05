# BSUID authority for WhatsApp identity

- **Status:** Accepted
- **Date:** 2026-08-04
- **Amends:** [ADR-0002 Fidy product identity and public namespace](./0002-fidy-product-identity-and-public-namespace.md)
- **Amends:** [ADR-0007 PostgreSQL row-level User isolation](./0007-postgresql-row-level-user-isolation.md)
- **Amends:** [ADR-0010 WhatsApp channel operational slice](./0010-whatsapp-channel-operational-slice.md)
- **Active specification:** [WhatsApp channel adapter (Kapso)](https://github.com/B4rz99/fidy-ai/issues/10)

## Context

Meta identifies a WhatsApp caller with a Business Scoped User ID (BSUID) scoped to one Business
Portfolio. Phone numbers can be absent, changed, or reassigned to another person. Treating a phone
match as pre-subject authority can therefore expose an existing User's financial data and can turn a
recycled number into a durable reassociation. Conversely, replacing `UserId` with BSUID would make
Fidy's durable identity depend on one channel provider.

## Decision

`UserId` remains Fidy's stable subject. A WhatsApp association is authorized only by the pair
`(BusinessPortfolioId, BSUID)`, where the portfolio comes from trusted deployment configuration and
the BSUID comes from an authenticated provider event or explicit support-recovery verification. The
privileged pre-subject resolver accepts only that pair and returns only `UserId`.

Phone number, username, and parent BSUID are nullable mutable evidence. They may be refreshed only
after the authoritative pair resolves and may never independently resolve, authorize, or
reassociate a User. Association changes use Meta's structured `user_changed_user_id` system event,
received through Kapso's exact raw forwarding webhook and authenticated before parsing. Identity
atomically validates the old portfolio-plus-BSUID pair, records the provider message id, and replaces
it with the event's new BSUID while portfolio and occurrence time remain server/provider context.
Duplicate and stale events are acknowledged without changing current authority. Missing replacement
evidence clears the obsolete observation. Ordinary message observation cannot change the
association.

A cross-slice WhatsApp caller reference contains only Business Portfolio and BSUID. Mutable caller
evidence remains in Identity or the WhatsApp operational adapter and is not embedded in Consent.
Pending consent and caller-scoped locks use only the stable reference.

All outbound WhatsApp delivery uses the resolved BSUID as Kapso's `recipient`. Retained phone
evidence is never a delivery destination. Pre-launch phone-keyed associations and work admitted
through them have no authenticated BSUID and are deleted during migration rather than assigned
fabricated provider identities.

## Consequences

ADR-0002's fixed Kapso callback gains `/webhooks/kapso/meta` as a second provider-only forwarding
endpoint for exact raw Meta events; it is not a canonical product API route. ADR-0007's phone-only
WhatsApp gateway is replaced by a portfolio-plus-BSUID gateway while its
narrow-output and privilege rules remain. ADR-0010's phone-scoped ingress wording and phone-addressed
delivery no longer apply; ingress, windows, and delivery bind to the authoritative association.
Users who lose that association need an authenticated identity-change or support-mediated recovery
path rather than automatic phone fallback.

## Rejected alternatives

### Use phone as reconciliation fallback

Rejected because possession of a recycled phone number is not proof that the caller owns the prior
User, and automatic persistence would turn one mistaken match into a durable takeover.

### Prefer phone for outbound delivery when retained

Rejected because retained evidence may be stale and could disclose personal financial content to a
new holder of the number.

### Fabricate BSUIDs for pre-launch rows

Rejected because generated values are not provider-authenticated identities and the product has no
released compatibility obligation.
