# Kapso automatic disclosure-delivery reconciliation

## Question

Can Fidy safely resolve WhatsApp Consent disclosure outcomes using authenticated Kapso lifecycle webhooks without replaying an ambiguous send?

This report evaluates only provider-supported evidence. It does not treat recipient phone data, message content, operator judgment, or Fidy's own stored state as evidence that the provider accepted, delivered, or rejected a message.

## Decision summary

Use authenticated Kapso lifecycle webhooks as the sole automatic reconciliation path:

1. Send a fresh `biz_opaque_callback_data` value with every disclosure attempt.
2. Authenticate exact webhook body bytes before decoding.
3. Correlate lifecycle evidence only by that opaque value.
4. Treat `sent` and synchronous provider acceptance as nonterminal.
5. Advance Consent only after verified delivered evidence.
6. If lifecycle evidence never arrives, leave the attempt ambiguous indefinitely and never replay it automatically.

## Sourced findings

### 1. Kapso lifecycle webhooks retry, but not indefinitely

Kapso documents automatic webhook retry when an endpoint does not return `200`. The documented schedule is the initial attempt followed by retries after 10, 40, and 90 seconds, for about 2.5 minutes total. After exhaustion, the delivery is marked failed. Kapso can also pause a webhook after sustained failures; pending deliveries are then marked failed and skipped until the webhook is re-enabled. [Kapso webhook delivery documentation](https://docs.kapso.ai/docs/platform/webhooks/advanced)

**Conclusion:** webhook reconciliation is safe but not guaranteed to make progress. A missed lifecycle webhook can leave an attempt ambiguous indefinitely.

Kapso separately exposes webhook-delivery metadata such as delivery status, attempt count, response status, event type, and timestamps. Its documented result does not include the webhook payload, WhatsApp message ID, or opaque callback value. [Kapso `GET /webhook_deliveries`](https://docs.kapso.ai/api/platform/v1/webhook-deliveries/list-webhook-deliveries)

**Conclusion:** webhook-delivery metadata is useful for monitoring but cannot prove the outcome of one disclosure attempt.

### 2. Sending supports exact opaque correlation

Kapso's send-message schema documents `biz_opaque_callback_data` as an arbitrary tracking string, up to 512 characters, that is echoed in webhooks. A successful synchronous send response returns a WhatsApp message ID (WAMID). [Kapso send-message operation](https://docs.kapso.ai/api/meta/whatsapp/messages/send-a-message)

The same operation does not document a client-supplied idempotency key or client request ID for message submission. [Kapso send-message operation](https://docs.kapso.ai/api/meta/whatsapp/messages/send-a-message)

**Conclusion:** an ambiguous HTTP outcome can leave Fidy without a WAMID. The opaque callback value is the exact identifier Fidy controls before crossing the provider boundary.

### 3. Lifecycle payloads contain chronological status history

Kapso documents `message.kapso.statuses` as the complete chronological history of raw Meta status events, with each entry represented as the unmodified Meta webhook payload. [Kapso message events: Status history](https://docs.kapso.ai/docs/platform/webhooks/event-types#status-history)

Kapso documents `biz_opaque_callback_data` as echoed in those webhook events. [Kapso send-message operation](https://docs.kapso.ai/api/meta/whatsapp/messages/send-a-message)

**Conclusion:** multiple signed status entries are valid. Fidy should authenticate the full body, require the event header to agree with the authenticated current status, and select the latest matching status for the WAMID. Older entries are history, not payload conflicts.

## Automatic design

- Verify exact body bytes with the Kapso webhook secret before decoding.
- Project only WAMID, lifecycle status, occurrence time, safe failure code, and opaque correlation.
- Apply evidence idempotently through the disclosure-delivery module.
- Return `200` only after durable application or recognized replay so Kapso's bounded retries can recover temporary Fidy failures.
- Retain `sent` evidence only for chronology.
- Let verified delivery atomically advance the WhatsApp attempt and Consent exchange.
- Schedule bounded jittered retry only after authenticated, definitive, allowlisted transient failure evidence.
- Leave missing evidence ambiguous forever; do not substitute identity, content, approximate timestamps, logs, or automatic replay.
