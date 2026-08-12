import { Crypto, DateTime, Effect } from "effect";
import type { UserId } from "~/core/identity/reference";
import { Memory, MemoryId, type RememberInput } from "~/core/memory/model";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import type { OperationResponse } from "~/shell/_shared/response";
import type { HostedInference } from "~/shell/agent/hosted-inference";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { type MemoryCapacityExceededApi, mapMemoryFailure } from "./errors";
import { countAndAdmitMemory } from "./memory-policy";
import { insertMemoryInScope, listMemoriesInScope } from "./repo";

type RememberResponse = ReturnType<typeof OperationResponse<typeof Memory>>["Type"];

/** Final server-owned facts supplied after canonical decoding and authorization. */
export type RememberMemoryInput = Readonly<{
  userId: UserId;
  payload: RememberInput;
}>;

/**
 * Counts and inserts one Memory under the User aggregate lock without opening a transaction. The
 * canonical caller owns commit or rollback, allowing the same implementation in an atomic batch.
 */
export const rememberMemory: CanonicalMutationImplementation<
  RememberMemoryInput,
  RememberResponse,
  MemoryCapacityExceededApi,
  Crypto.Crypto | HostedInference
> = Effect.fn("rememberMemory")(function* ({ userId, payload }) {
  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now;
  const candidate = Memory.make({
    id: MemoryId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
    text: payload.text,
    createdAt: now,
    updatedAt: now,
  });
  return yield* withUserLockInScope(
    advisoryLockKey.memories(userId),
    Effect.gen(function* () {
      const current = yield* listMemoriesInScope(userId);
      const admitted = yield* countAndAdmitMemory(current, candidate).pipe(
        Effect.mapError(mapMemoryFailure)
      );
      const stored = yield* insertMemoryInScope(userId, admitted);
      return { data: stored, next: [] };
    })
  );
});
