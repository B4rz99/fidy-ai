/**
 * HISTORICAL PLANNING ARTIFACT — issue #10.
 *
 * The proposal was implemented and its candidate declarations were removed to
 * prevent a parallel type model. Canonical production declarations now live at:
 *
 * - `src/shell/channels/whatsapp/kapso-webhook.ts` — authenticated provider projection
 * - `src/shell/channels/whatsapp/kapso-client.ts` — outbound provider boundary
 * - `src/shell/channels/whatsapp/repo.ts` — durable queue, claims, and window state
 * - `src/shell/channels/whatsapp/outbound.ts` — consent and free-form delivery policy
 * - `src/shell/channels/whatsapp/worker.ts` — serialized burst processing
 *
 * Architecture rationale and rejected alternatives remain in
 * `docs/plans/issue-10-architecture.html` and `research/006-kapso-channel-adapter.md`.
 */
export {};
