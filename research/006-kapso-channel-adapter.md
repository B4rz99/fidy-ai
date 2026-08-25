# Kapso channel adapter research

Research for [issue #10](https://github.com/B4rz99/fidy-ai/issues/10). This is a planning source, not production implementation.

## Decision summary

Use a phone-number-scoped **Kapso platform webhook** (`kind: kapso`, payload version `v2`) subscribed to `whatsapp.message.received`. Verify its HMAC before decoding, project text or Kapso's audio transcript through the implemented `evaluateConsentGate`, and durably enqueue only its `Proceed` outcomes before acknowledging. Process authorized due work through `AgentService.handleTurn` after a 2.5-second per-User quiet period. Use the official Kapso TypeScript SDK only behind a narrow outbound adapter, and decode its response again at Fidy's trust boundary.

The adapter will not introduce a generic channel or identity framework.

## Primary-source findings

### Webhook kind and shape

Kapso distinguishes event-based Kapso webhooks from raw forwarded Meta webhooks. Phone-number-scoped Kapso webhooks support event filtering and buffering; payload version v2 places `phone_number_id` at the top level. Unbuffered `whatsapp.message.received` bodies contain `message`, `conversation`, `is_new_conversation`, and `phone_number_id`; buffered deliveries wrap equivalent items in `{ type, batch: true, data, batch_info }`.

Sources:

- [Kapso webhook overview](https://docs.kapso.ai/docs/platform/webhooks/overview)
- [Kapso message event payloads](https://docs.kapso.ai/docs/platform/webhooks/event-types)
- [Kapso delivery, batching, ordering, and retries](https://docs.kapso.ai/docs/platform/webhooks/advanced)

**Conclusion:** Fidy should decode both single and batch envelopes even if provider buffering is disabled. Kapso documents a configurable maximum buffered batch size of 100 events, which supplies the event-count bound. It documents no HTTP byte-size maximum, so any raw-body byte cap is a provisional Fidy resource guard that must be checked against the largest recorded valid fixture. Fidy still owns its required 2.5-second debounce and must not depend on provider buffering for semantics.

### Authenticity and acknowledgment

Kapso signs the raw JSON payload with HMAC-SHA256 using the webhook secret and sends the hex signature in `X-Webhook-Signature`. Verification must use the raw body and timing-safe comparison. Kapso asks receivers to return `200` within 10 seconds and recommends asynchronous processing. Failed deliveries are retried, so `X-Idempotency-Key` must be handled idempotently.

Sources:

- [Kapso webhook security](https://docs.kapso.ai/docs/platform/webhooks/security)
- [Kapso webhook overview](https://docs.kapso.ai/docs/platform/webhooks/overview)
- [Kapso delivery and retry policy](https://docs.kapso.ai/docs/platform/webhooks/advanced)

**Conclusion:** verify before JSON decoding; commit deduplicated queue work before returning `200`; return `401` for absent, malformed, or invalid signatures without side effects. Do not log bodies, signatures, or secrets.

### Identity and provider evidence

Kapso now supports phone-less business-scoped identity and warns consumers not to assume `phone_number`, `from`, `to`, or `wa_id` is present. Issue #10 deliberately requires Fidy's concrete normalized E.164 `WhatsAppIdentity`, and the architecture rejects a generic identity-provider framework.

Sources:

- [Kapso webhook overview](https://docs.kapso.ai/docs/platform/webhooks/overview)
- [Kapso message event payloads](https://docs.kapso.ai/docs/platform/webhooks/event-types)
- [`CONTEXT.md`](../CONTEXT.md), `WhatsAppIdentity`
- [Server architecture](../apps/server/ARCHITECTURE.md), §5

**Conclusion:** decode with `E164PhoneNumber` from `core/identity/reference.ts` and resolve an accepted association with the existing `resolveWhatsAppCaller`. Never use Kapso conversation ids, WAMIDs, BSUIDs, usernames, or contact ids as authority. A phone-less event is unsupported. An unassociated real phone enters issue #8's onboarding boundary instead of being discarded or sent to the agent.

### Text, voice, and message ids

Inbound text is available as `message.text.body`. For audio messages Kapso adds `message.kapso.transcript.text`; the webhook also carries the WhatsApp message id in `message.id`. Kapso's examples use WAMIDs such as `wamid.123`.

Source: [Kapso message event payloads](https://docs.kapso.ai/docs/platform/webhooks/event-types).

**Conclusion:** model text and transcribed voice as a discriminated union, then project either to `InboundMessage.text`. Missing or empty audio transcription fails decoding and never reaches the model. Deduplicate on `message.id`; retain that provider id only in channel evidence, not as identity or domain data.

### Customer-service window and outbound SDK

Kapso states that non-template messages require an open 24-hour customer-service window; approved templates are required to start or reopen a conversation. The official `@kapso/whatsapp-cloud-api` package exposes `WhatsAppClient` and `client.messages.sendText({ phoneNumberId, to, body })`.

Sources:

- [Kapso send-text documentation](https://docs.kapso.ai/docs/whatsapp/send-messages/text)
- [`gokapso/whatsapp-cloud-api-js` README at commit `91de0d1`](https://github.com/gokapso/whatsapp-cloud-api-js/blob/91de0d154f91bba1784cec7793de753af895730a/README.md)
- [`TextMessageSender` at commit `91de0d1`](https://github.com/gokapso/whatsapp-cloud-api-js/blob/91de0d154f91bba1784cec7793de753af895730a/src/resources/messages/text.ts)

**Conclusion:** persist `windowOpenUntil = latest inbound message timestamp + 24 hours`; expose it as an open/closed union; check it immediately before every free-form send. The production adapter may use SDK version `0.2.3`, but its output is still untrusted and is decoded into Fidy's minimal `{ providerMessageId }` result.

## Proposed persistence

1. `whatsapp_inbound_receipts`: content-free processing/completed claims that suppress every authenticated WAMID replay before consent effects.
2. `whatsapp_ingress_budgets`: short-lived phone/User counters enforcing cross-instance hourly abuse bounds.
3. `whatsapp_message_evidence`: metadata-only inbound/outbound provider ids attributable to stable `UserId`; no payload body.
4. `whatsapp_inbound_jobs`: transient normalized text/transcript needed by the durable queue; removed after terminal dispatch.
5. `whatsapp_turn_claims`: content-free Claimed, Started, and Failed state enforcing one active turn per User across workers.
6. `whatsapp_conversation_windows`: one current `window_open_until` bound to the stable User's Identity verification time, without retaining the phone number; scheduled retention removes expired rows and budget keys independently of later traffic.

The receipt's unique provider-message id is the all-message redelivery guard; the delivery key remains qualified inbound evidence and need not be unique across every event in a provider batch. The route acknowledges work only after its terminal consent outcome or authorized queue transaction commits and the receipt is completed.

## Existing seams to reuse

The latest architecture publishes stable cross-slice values from their owning slice's `reference.ts`. This adapter should import `UserId` and `E164PhoneNumber` from `core/identity/reference.ts`, reuse Identity's WhatsApp operations, and prefactor the conversation boundary into admission followed by execution. The existing immediate path admits one provider message and calls `AgentService.handleTurn`; WhatsApp instead admits each real WAMID, queues authorized messages, and calls AgentService once after collapse. It needs no core counterpart and must not duplicate those references. Under the repository's service rule, only the true-external Kapso client earns a `Context.Service`; webhook orchestration and repositories remain plain functions exercised through the HTTP seam.

## Isolation decision

Issue #81 implemented the RLS revisit condition in ADR-0007. The four Kapso User-owned relations must join forced RLS and `withUserTransaction`. Global due-work discovery must use the ADR's narrow gateway pattern: atomically return only an opaque claim identity and stable `UserId`, end that transaction, then load content under User context. Queue acceptance and exact outbound projection are consent-dependent short database units under ADR-0008; no queue lock or database transaction spans an agent/model or Kapso call.

Per-User serialization must survive multiple worker fibers or application instances, so claim state belongs in PostgreSQL rather than only an in-memory active-User set. Concurrent work for Users A and B must still prove that Transcript entries, canonical writes, windows, queue content, and outbound recipients cannot mix.

## Landed dependencies

[Issue #8](https://github.com/B4rz99/fidy-ai/issues/8) and [issue #81](https://github.com/B4rz99/fidy-ai/issues/81) are complete. The adapter evaluates every decoded provider event through `evaluateConsentGate` before debounce. Terminal consent outcomes are rendered immediately; only `Proceed` carries a stable `UserId` into durable queueing. `Accepted` remains a terminal consent turn, so the User sends the original financial request again after onboarding. Disclosure delivery uses `recordConsentDisclosureDelivery`; Consent remains the sole owner of pending exchange and ConsentRecord evidence.
