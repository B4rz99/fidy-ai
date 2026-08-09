# Issue 159 implementation plan

## Seam

Exercise the public `AgentService.handleSynchronousTurn` seam with the real canonical API and PostgreSQL. Substitute only the scripted language model, as required by `ARCHITECTURE.md` §8 and the issue acceptance criteria.

## Change

1. Preflight every accepted model tool call into an encoded canonical call before recording or executing any call from that model response.
2. Reject independently emitted confirmation-required mutations as one whole response and return tool feedback directing the model to `operations.executeAtomicBatch`.
3. Extend host confirmation so the visible atomic-batch operation renders one ordered batch challenge, binds the exact canonical batch input to a cryptographically unique digest, expires after ten minutes, and atomically persists its single-use consumption for an exact `CONFIRMAR LOTE <digest>` command.
4. After confirmation, invoke `operations.executeAtomicBatch` through the normal hosted toolkit without a second host validation phase. Preserve the canonical batch result or actionable failure as the recorded tool outcome so the model can produce the final semantic reply.
5. Keep single-operation confirmation behavior, while preventing any sibling call in the same generated response from executing before confirmation is settled.

## Tracer tests

- One exact batch challenge, confirmation, ordered execution, and semantic final reply.
- Altered, expired, sequentially replayed, and concurrently replayed confirmation execute nothing.
- Multiple independent confirmation-required mutations execute nothing and are corrected to the batch tool.
- A malformed later call prevents an earlier mutation from executing.
- A confirmed authoritative child failure rolls back earlier children, cannot replay the consumed challenge, and yields an actionable User-facing reply.
