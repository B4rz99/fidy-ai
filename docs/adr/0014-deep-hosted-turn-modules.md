# Deep hosted-turn modules enforce continuity invariants

- **Status:** Accepted; ownership model superseded by [ADR 0019](0019-hosted-runtime-owns-conversation-continuity.md)
- **Date:** 2026-08-11

## Context

Issue #11 requires the request measured at preflight to be the request sent to hosted inference, one semantic WorkingContext order, and retry-safe Compaction over exact retained conversation. Memory and conversation continuity are separate purposes: Memory is explicit durable economic context, while Compaction is lossy continuity for retained conversation.

### Current architecture

The current implementation distributes these guarantees across `AgentService`, caller-assembled prompt arrays, caller-adjustable agent limits, model continuation values, token counters, Transcript queries, and delivery orchestration. Turn completion is inferred from Transcript shape. Context selection uses a recent-Turn window, and active User text may be persisted before complete provider-facing capacity is known.

That shape exposes several illegal states: measuring one request and executing another, reordering or truncating prompt sections, allowing provider state or model capacity into orchestration, accepting a domain-valid Transcript entry that storage cannot retain, leaving failed work outside an explicit terminal lifecycle, and permanently blocking a contiguous Compaction prefix with abandoned work.

### Recommended architecture

Replace that distributed policy with three deep modules. Their public contracts make provider fidelity, context order, and conversation lifecycle module invariants rather than caller conventions.

The research sketches under `reports/issue-11/` are decision inputs, not accepted interfaces. This ADR supersedes those sketches wherever they expose caller-owned policy, capacity, or prompt assembly.

## Decision

Use three deep modules behind small interfaces:

- **HostedInference** owns provider conversion, compatible token counting, verified context capacity, request preparation, and execution. It converts a semantic hosted request into an opaque, adapter-local `PreparedHostedRequest`, measures its complete provider-facing messages, canonical tools or strict structured-output format, framing, and output reserve, and executes only that exact prepared representation. Startup validation and live calls use the same preparation implementation. Production OpenAI and deterministic test adapters implement this external seam.
- **WorkingContext** owns the sole construction and projection of one Turn's semantic context. Its only legal order is `[system and per-turn policy | all active Memories | CompactedConversation, if any | exact uncompacted Transcript | active request]`. It supplies trusted policy itself and projects persisted or generated prose as untrusted User context. One immutable WorkingContext may be reused across every hosted round in the Turn.
- **ConversationContinuity** owns explicit Turn lifecycle, exact Transcript persistence, abandoned-Pending recovery, retention, complete-prefix Compaction, optimistic commit, and physical deletion. PostgreSQL remains concrete behind this module; callers do not coordinate rows, cursors, revisions, or deletion.

The boundaries own their policies completely:

- HostedInference is the only module that knows provider model or tokenizer identifiers, provider framing, continuation representation, or total context capacity.
- WorkingContext is the only module that may order or project context sections. Callers provide semantic domain values, not policy or prompt fragments.
- ConversationContinuity is the only module that admits or terminalizes a Turn and changes retained conversation state. Compaction model work occurs outside a transaction; optimistic state validation, replacement, and exact-prefix deletion commit atomically afterward.

Memory remains a separate deep module exposing the canonical `remember`, `recall`, `revise`, and `forget` operations behind one content-agnostic MemoryPolicy. Remember admission measures the exact generated Memory identity that persistence uses. Every committed Memory insert, revision, or deletion advances a trigger-backed monotonic per-User continuity revision, so a prepared context cannot survive a Memory change.

### Public contract exclusions

This section is the accepted public-type proposal; no type sketch under `reports/` is part of the decision. The proposed public types intentionally expose none of the following:

- raw provider messages, continuation state, response-format framing, tokenizer identities, or model identities;
- caller-supplied context capacity, aggregate budget arithmetic, Compaction thresholds, or output-capacity decisions;
- caller-assembled system policy, per-turn policy, prompt arrays, or fragments that can be appended or reordered after WorkingContext construction;
- constructible prepared requests, Turn handles, or cross-User persistence authorities.

Server-owned policy values remain independently named even when launch values coincide. Prepared requests and mutation authorities are bound to the adapter, User, revision, or Turn that created them and are rejected when stale or already consumed. Prepared continuity context and WorkingContext are immutable data: their owning modules construct them, and runtime capability registries do not authenticate them. (ADR 0019: prepared continuity context no longer crosses a module seam at all, and no Turn authority is reachable by any caller.)

### Legal hosted-Turn sequence

1. ConversationContinuity acquires the per-User session-scoped serialization authority, recovers abandoned Pending work as Interrupted, optionally attempts safe Compaction, and returns one immutable revision-bound continuity context.
2. WorkingContext constructs immutable semantic context from its trusted policy, all current Memories, the prepared context's optional CompactedConversation and exact Transcript, and the in-memory active request.
3. HostedInference prepares and measures the complete provider-facing request, canonical tools, framing, and output reserve.
4. Only after preflight succeeds, `beginTurn` compares the continuity and Memory revisions and persists the active User entry as a Pending Turn. If either changed, it appends nothing, discards the prepared execution, and restarts at step 1. Retries are bounded to three before failing closed.
5. HostedInference executes only the prepared request. Later model rounds reuse the same WorkingContext; canonical calls and complete bounded outcomes extend only the prepared Turn continuation owned by HostedInference.
6. Delivery retries reuse the exact prepared reply and never rerun inference or canonical mutations.
7. Visible delivery records Completed. A handled model or exhausted delivery failure records Failed with a fixed metadata-only reason. Cancellation or process abandonment is recovered as Interrupted by the next preparation. The serialization authority is then released.

A per-User PostgreSQL session advisory lock fences this sequence across processes through delivery finalization. It reserves one connection but opens no database transaction across hosted inference or provider delivery.

### Turn and retention rules

A Turn is Pending only after complete hosted preflight succeeds and its exact active User Transcript entry is retained. Completed, Failed, and Interrupted are terminal. Failed and Interrupted Turns retain the exact User entry plus a fixed metadata-only terminal marker and can participate in a contiguous Compaction prefix, preserving chronology without making one outage block later Compaction.

Every domain-valid Transcript entry must round-trip through the PostgreSQL adapter, including maximum-length multibyte Unicode and bounded canonical-tool evidence. Storage may not add an undocumented narrower generic serialized-byte contract.

Compaction is triggered only by HostedInference-compatible token count. It rewrites any prior CompactedConversation plus the next contiguous complete terminal-Turn prefix into one bounded replacement. Model failure, malformed or oversized output, stale continuity, stale immutable Consent evidence, or database failure advances no cursor and deletes nothing. A successful optimistic commit persists the replacement and physically deletes exactly the incorporated Transcript prefix in one transaction. Exact conversation continues after failure only while a complete request still fits; otherwise the Turn fails explicitly rather than silently omitting context.

## Privacy and security contract

Memory has the explicit durable-economic-context purpose. Transcript, Compaction, CompactedConversation, WorkingContext, and hosted-model egress each retain or process prose only for their separately stated conversation-continuity purpose. Successful Compaction physically deletes incorporated exact Transcript text; `forget` physically deletes a Memory; only current Memories are recalled. Other bounded retention and User deletion paths must remain executable rather than documentary.

Fidy does not classify or censor arbitrary User prose by semantic content. Such classification cannot soundly and completely detect credentials, financial identifiers, protected attributes, temporary details, canonical-record facts, or other sensitive material. The hosted agent therefore never solicits credentials, tokens, passwords, card numbers, account numbers, or unnecessary sensitive personal data and warns the User not to submit them. Typed Secrets entering an intended Secret boundary remain excluded from Transcript, Memory, Compaction, and model context.

AuditLogEntries, terminal markers, logs, telemetry, and errors contain allowlisted metadata only. They never contain Memory text, Transcript prose, model bodies, exception text, caller-controlled Memory ids, or disguised request bodies.

## Consequences

An unmeasured hosted request, caller-selected capacity, and indefinitely blocking abandoned Turn are no longer caller-constructable states. WorkingContext keeps semantic ordering local to its constructor without turning immutable data into a runtime capability. Provider conversion, capacity arithmetic, lifecycle recovery, retention, and Compaction remain local to their owners. Tests use the same interfaces as production callers. (ADR 0019 supersedes this paragraph's coordinator model: `AgentService` owns conversation continuity lexically rather than coordinating with it.)

A continuity snapshot can become stale between preflight and `beginTurn`; this is an explicit retry result rather than a partial admission. Failed and Interrupted User text can eventually become lossy CompactedConversation and be physically deleted under the same disclosed retention semantics as completed conversation.

## Rejected alternatives

- Keep token counting separate from provider request construction: rejected because measured and executed representations can drift.
- Let orchestration assemble prompt order: rejected because order would drift across callers instead of remaining local to WorkingContext construction.
- Expose capacity or context budgets as caller-adjustable configuration: rejected because callers could authorize requests the provider boundary cannot safely execute.
- Carry raw provider continuation through AgentService: rejected because provider state could be inspected, forged, or paired with a different prepared context.
- Infer Turn completion from the last Transcript entry: rejected because model, delivery, and process failures have no safe terminal representation.
- Skip an incomplete Turn and compact later Turns: rejected because CompactedConversation plus a retained earlier Turn would no longer preserve chronology.
- Let an incomplete Turn block the prefix forever: rejected because repeated failure would eventually force context rejection despite later terminal Turns.
- Semantically classify arbitrary Memory or Transcript prose: rejected because incomplete classification creates a false security boundary and inconsistent retention behavior.
