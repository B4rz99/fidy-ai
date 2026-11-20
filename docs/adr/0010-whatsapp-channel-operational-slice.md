# WhatsApp channel operational slice

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

ADR 0003 classifies `channels` as shell-only because channel adapters ordinarily own no data. The
WhatsApp channel needs durable, channel-specific operational state for authenticated provider
evidence, authenticated receipt claims, bounded ingress budgets and jobs, processing claims, and
provider conversation windows. Those
relations have invariants that no domain slice owns, while moving Kapso mechanics into a domain
slice would make a provider boundary part of the business model.

## Decision

Treat `src/shell/channels/whatsapp` as a shell **operational slice** nested beneath the channel
adapter area. It owns only WhatsApp delivery and ingress-control state:

- authenticated provider-message evidence and pre-subject receipt claims;
- bounded aggregate/phone/User ingress budgets;
- bounded inbound jobs and their claim lifecycle; and
- WhatsApp free-form conversation windows, bound to Identity verification time rather than a retained phone number.

An in-flight receipt is retryable rather than acknowledged as a completed duplicate. Every
authenticated provider message consumes each aggregate, phone, or User ingress budget at most
once, including after failed admission and redelivery. A receipt marked `outbound_started` is
terminally ambiguous and is acknowledged on redelivery rather than risking duplicate User
communication or provider spend. A scheduled content-free retention gateway removes expired
ingress budgets and conversation windows
independently of later inbound traffic. The operational slice may own repositories and migrations
for those relations. It must call Identity and Consent owner operations rather than reading or
writing their tables. Consent owns the expiring claim that serializes disclosure delivery; an
active pre-provider claim makes webhook admission retryable and may be reclaimed after expiry.
Before the provider call, both the inbound receipt and disclosure claim are durably marked started;
an interrupted call is retained for reconciliation rather than automatically replayed. This gives
each disclosure at least one delivery attempt without turning an ambiguous attempt into duplicate
User messages or provider spend. No database transaction or claim lock spans the provider call. The channel hands admitted turns to `AgentService` rather than owning financial
behavior. The worker prepares an Agent reply, delivers it, and only then records its visible
assistant Transcript entry.

Kapso-specific code remains limited to webhook authentication/decoding and the outbound client.
The client bounds response bytes before SDK decoding and rejects malformed provider evidence.
This decision is a narrow qualification of ADR 0003's consequence that `channels` owns no data;
the layer-major tree and the rule that every relation has one owner remain unchanged.

## Consequences

The WhatsApp directory is data-owning even though the surrounding `channels` area remains
shell-only coordination. Future durable channel state requires its own accepted decision rather
than turning this exception into a generic provider framework.

The durable receipt, budget, queue, and evidence relations have a clear owner, while User identity, consent, and
financial aggregates remain in their existing slices.

## Rejected alternatives

### Put WhatsApp delivery state in Identity or Consent

Rejected because queue claims, provider evidence, and conversation windows are not invariants of
either domain slice.

### Introduce a generic channel-provider slice framework

Rejected because there is one concrete channel requirement and no demonstrated shared model.

### Keep the relations ownerless

Rejected because ADR 0003 requires every data-owning process to be a slice.

## Provider boundaries

Template configuration is an operator-approved snapshot. Category disclosures and financial
summaries use separately approved templates. The owner freezes the complete body, Currency
keyspace and template identity. Delivery enforces both UTF-16 and UTF-8 limits and Meta's
whitespace restrictions. It refuses an invalid or mismatched configuration before sending.
Truncation would change the User's evidence or financial facts.

Ordinary outbound routing uses the authenticated portfolio-scoped BSUID. Only explicit operator
Sandbox configuration can route by provider-observed phone evidence, because this Kapso Sandbox
refuses BSUID destinations. Keep its HTTP 403 diagnosis without exposing the provider body.
Each attempt can issue one provider mutation. A subsequent retry requires authenticated evidence
that a transient attempt was rejected. Unknown codes, lost responses and uncertain acceptance
do not authorize another send.

Authenticate bounded exact raw webhook bytes before parsing. Trust only the configured Business
Portfolio. Provider event clocks can lead receipt by five minutes, and second-precision status
ties cannot use input array order as authority. Only matching delivered evidence can settle a
User-owned attempt. Kapso may publish a sent hint before history exists. A bounded fixed-origin
read can confirm an exact stored attempt using its retained coordinates; a signed hint alone
does not prove delivery. The OpenSSL-generated HMAC vector in the webhook tests exercises proof
verification against independently generated bytes.

Provider schemas consulted during implementation cover the [Kapso v2 media events](https://docs.kapso.ai/docs/platform/webhooks/message-events#media-messages-imagevideodocument),
[BSUID status history](https://kapso.com/guides/business-scoped-user-ids/introduction/reading-the-new-payload),
and [lifecycle events](https://github.com/gokapso/agent-skills/blob/master/skills/integrate-whatsapp/references/webhooks-event-types.md).
