import { jsonStringSchema } from "~/shell/schema-codecs/contract";
import { DateTime, Effect, Schema, Struct } from "effect";
import { Memory, type MemoryCapacityExceeded, type MemoryNotFound } from "~/core/memory/contract";
import { NotFound } from "~/shell/public-http/contract";
import {
  type MemoryAuditOperation,
  type MemoryAuditOutcome,
  MemoryCapacityExceededApi,
} from "./contract";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { liveWebSessionAuthority } from "~/shell/identity/browser-runtime";
import { admitMemory } from "~/core/memory/operations";
import { HostedInference } from "~/shell/hosted-inference/operations";

const MemoryProjection = Memory.mapFields(Struct.pick(["id", "text"]));
const encodeMemoryProjection = Schema.encodeSync(jsonStringSchema(MemoryProjection));

/** Encodes recall-ordered `{id,text}` projections as one compact JSON object per LF-delimited line. */
const projectMemoryAggregate = (memories: ReadonlyArray<Memory>): string =>
  memories.map((memory) => encodeMemoryProjection(memory)).join("\n");

const compareRecallOrder = (left: Memory, right: Memory): number => {
  const instant = DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt);
  if (instant !== 0) return instant;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
};

const countAndAdmitFinalAggregate = Effect.fn("countAndAdmitFinalAggregate")(function* (
  final: ReadonlyArray<Memory>,
  candidate: Memory
) {
  const inference = yield* HostedInference;
  const finalRecallOrder = [...final].sort(compareRecallOrder);
  const tokens = yield* inference.countText(projectMemoryAggregate(finalRecallOrder));
  return yield* admitMemory({ candidate, aggregateTokens: tokens });
});

/** Counts the complete stable aggregate locally before admitting one new Memory. */
export const countAndAdmitMemory = Effect.fn("countAndAdmitMemory")(function* (
  current: ReadonlyArray<Memory>,
  candidate: Memory
) {
  return yield* countAndAdmitFinalAggregate([...current, candidate], candidate);
});

/** Counts a complete aggregate with one current Memory replaced in place. */
export const countAndAdmitMemoryRevision = Effect.fn("countAndAdmitMemoryRevision")(function* (
  current: ReadonlyArray<Memory>,
  candidate: Memory
) {
  const final = current.map((memory) => (memory.id === candidate.id ? candidate : memory));
  return yield* countAndAdmitFinalAggregate(final, candidate);
});

/** Maps the closed Memory failure set without copying prose or caller-controlled identity. */
export function mapMemoryFailure(failure: MemoryCapacityExceeded): MemoryCapacityExceededApi;
export function mapMemoryFailure(failure: MemoryNotFound): NotFound;
export function mapMemoryFailure(
  failure: MemoryCapacityExceeded | MemoryNotFound
): MemoryCapacityExceededApi | NotFound {
  switch (failure._tag) {
    case "MemoryCapacityExceeded":
      return MemoryCapacityExceededApi.make({
        error: {
          code: "quota_exhausted",
          message: "Saving this text would exceed the User's current Memory capacity.",
        },
        next: [],
      });
    case "MemoryNotFound":
      return NotFound.make({
        error: {
          code: "not_found",
          message: "No current Memory with that identifier belongs to you.",
        },
        next: [],
      });
  }
}

type BrowserMemorySubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;

/**
 * Count one browser Memory call only for its live User-owned WebSession. `afterMutation` additionally
 * requires the preceding owner mutation in the same D1 unit to have changed a row, so a skipped
 * mutation cannot be audited as accepted.
 */
export const recordBrowserMemoryWork = ({
  subject,
  input,
}: Readonly<{
  subject: BrowserMemorySubject;
  input: Readonly<{
    id: string;
    operation: MemoryAuditOperation;
    outcome: MemoryAuditOutcome;
    afterMutation: boolean;
    current: number;
  }>;
}>): OwnedStatement => {
  const authority = liveWebSessionAuthority({ subject, current: input.current });
  return {
    sql: `INSERT INTO memory_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
      SELECT ?,user_id,id,?,?,? FROM ${authority.table} WHERE ${authority.predicate}
      ${input.afterMutation ? "AND changes() = 1" : ""}`,
    params: [input.id, input.operation, input.outcome, input.current, ...authority.bindings],
  };
};

export { maximumAggregateMemoryTokens } from "~/core/memory/operations";
