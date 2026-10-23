# Hosted inbound and document ownership — #1480

The Turn retains 26 stored fields plus generated inbound identity. The only proven duplicate in
the accepted provisional 27-field group is document_created_at_ms: Agent composes document
admission with Turn admission using the same Worker-owned now in the same native batch. Derive
that logical document creation instant from immutable started_at_ms while a document is present.
Validate historical equality before conversion; never replace a distinct historical instant.

| Retained Turn fields                                                                      | Owner and reason                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id, user_id, hosted_session_id                                                            | Agent identity and same-User session relationship; remain after transcript compaction.                                                                                                                                          |
| started_at_ms, terminal_at_ms, status, failure_reason                                     | Agent admission, original execution deadline and typed terminal result. Provider receipt or Queue time cannot replace them.                                                                                                     |
| proposal_receipt_digest, proposed_at_ms, proposal_text                                    | Agent's exact proposed visible reply and authenticated receipt. Generation alone is not completed delivery; the digest is not a bearer value.                                                                                   |
| retention_terminal_at_ms                                                                  | Bounded indexed discovery of remaining Turn evidence, including mutation receipts retained after transcript removal.                                                                                                            |
| inbound_portfolio_id, inbound_bsuid, inbound_message_id, inbound_business_phone_number_id | WhatsApp-owned original verified recipient/message association on this Turn. Live association is rechecked; a historical message cannot authorize another User or channel.                                                      |
| inbound_occurred_at_ms, inbound_received_at_ms                                            | Independent provider occurrence and trusted receipt instants. Delayed delivery/replay does not make them equal.                                                                                                                 |
| inbound_reply_to_message_id, inbound_sandbox_phone                                        | Optional original reply correlation and sandbox dispatch context; neither is current recipient authority.                                                                                                                       |
| dispatch_created_at_ms, dispatch_offered_at_ms                                            | WhatsApp outbox presence/abandonment age and last Queue handoff attempt. Failed offers change one without granting another Turn execution budget.                                                                               |
| document_media_id                                                                         | Ingestion's held attachment identity before bytes are fetched. A provider ID is not an R2 locator or publication permission.                                                                                                    |
| document_upload_grant_id, document_upload_expires_at_ms                                   | Exact bounded outstanding download lease, independently released/retried without resetting original Turn admission.                                                                                                             |
| document_staging_id, document_reference_json                                              | Same-User staging association and original verified reference snapshot. The snapshot fixes digest, bytes, sniffed format and staging expiry for recovery/publication; staging's mutable lifecycle is a separate responsibility. |

## Source trace

- agent/internal/turn-store.ts: prepareChannelAdmission, admitHostedTurn and recoverHostedTurn.
- whatsapp/internal/turn-evidence.ts and whatsapp-work.ts: atomic inbound/outbox composition,
  independently aged recovery, bounded offers and cleanup.
- agent/internal/statement-authority.ts: exact same-channel, same-User admitted Pending Turn and
  active session guards; Ingestion receives this live proof, not an inferred owner from a locator.
- ingestion/internal/statement-document.ts: admission before download; exact upload lease;
  recovery of the held reference without another download/budget charge.
- ingestion/internal/statement-mutation.ts and statement-staging.ts: same-User original hosted
  publication, staging ownership/integrity, replay identity and authoritative processing counters.
- agent/internal/hosted-turn.ts and turn-store.ts: Queue-to-User coordinator ordering, alarm/sweep
  recovery, original deadlines, proposal/receipt and exact terminal Transcript evidence.

No per-Turn Cloudflare Workflow or Effect Workflow is added. Statement/review interpretation and
processing remain Ingestion-owned; the Turn does not copy their counters or cached rows. The
proposal clock, Queue creation/offer clocks, media occurrence/receipt clocks and upload lease are
independent decisions, so substituting one for another would change recovery or authority.

Existing public hosted statement recovery checks cover interruption after staging/publication/
outcome, no duplicate capture or provider retrieval, same-channel confirmation, review continuation
and visible reply delivery. Existing hosted Turn checks cover abandonment, Queue handoff, original
soft deadlines and exact receipt settlement. Native conversion and inverse copy preserve original
Turn IDs, every remaining field, generated inbound identity, Transcript and committed receipts;
receipt children are copied before their cascade parent is rebuilt. Logical document erasure
keeps its original created_at_ms key/value and row address. No historical archive body is rewritten.
