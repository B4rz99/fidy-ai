import { liveWebSessionAuthority } from "~/shell/identity/operations";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { recordAuthorizedCall } from "~/shell/audit/operations";
import { jsonStringSchema } from "~/shell/schema-codecs/contract";
import { DateTime, Effect, Match, Schema, Struct } from "effect";
import { Memory, type MemoryCapacityExceeded, type MemoryNotFound } from "~/core/memory/contract";
import {
  type BrowserMemorySubject,
  type MemoryAuditOperation,
  type MemoryAuditOutcome,
  MemoryCapacityExceededApi,
} from "./contract";
import { NotFound } from "~/shell/public-http/contract";
import { admitMemory } from "~/core/memory/operations";
import { HostedInference } from "~/shell/hosted-inference/operations";

const MemoryProjection = Memory.mapFields(Struct.pick(["id", "text"]));

const encodeMemoryProjection = Schema.encodeSync(jsonStringSchema(MemoryProjection));

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

export const countAndAdmitMemory = Effect.fn("countAndAdmitMemory")(function* (
  current: ReadonlyArray<Memory>,
  candidate: Memory
) {
  return yield* countAndAdmitFinalAggregate([...current, candidate], candidate);
});

export const countAndAdmitMemoryRevision = Effect.fn("countAndAdmitMemoryRevision")(function* (
  current: ReadonlyArray<Memory>,
  candidate: Memory
) {
  const final = current.map((memory) => (memory.id === candidate.id ? candidate : memory));

  return yield* countAndAdmitFinalAggregate(final, candidate);
});

export function mapMemoryFailure(failure: MemoryCapacityExceeded): MemoryCapacityExceededApi;
export function mapMemoryFailure(failure: MemoryNotFound): NotFound;
export function mapMemoryFailure(
  failure: MemoryCapacityExceeded | MemoryNotFound
): MemoryCapacityExceededApi | NotFound {
  return Match.valueTags(failure, {
    MemoryCapacityExceeded: () =>
      MemoryCapacityExceededApi.make({
        error: {
          code: "quota_exhausted",
          message: "Saving this text would exceed the User's current Memory capacity.",
        },
        next: [],
      }),
    MemoryNotFound: () =>
      NotFound.make({
        error: {
          code: "not_found",
          message: "No current Memory with that identifier belongs to you.",
        },
        next: [],
      }),
  });
}

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

  return recordAuthorizedCall({
    authority,
    id: input.id,
    operation: input.operation,
    outcome: input.outcome,
    current: input.current,
    afterOwnerWrite: input.afterMutation,
  });
};
