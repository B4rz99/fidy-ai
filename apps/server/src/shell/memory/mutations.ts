import { Crypto, DateTime, Effect, Option } from "effect";
import type { UserId } from "~/core/identity/reference";
import { Memory, MemoryId, type RememberInput, type ReviseInput } from "~/core/memory/model";
import { MemoryNotFound } from "~/core/memory/rules";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import type { NotFound } from "~/shell/_shared/errors";
import type { OperationResponse } from "~/shell/_shared/response";
import type { HostedInference } from "~/shell/agent/hosted-inference";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { type MemoryCapacityExceededApi, mapMemoryFailure } from "./errors";
import { countAndAdmitMemory, countAndAdmitMemoryRevision } from "./memory-policy";
import {
  deleteMemoryInScope,
  insertMemoryInScope,
  listMemoriesInScope,
  updateMemoryInScope,
} from "./repo";

type MemoryResponse = ReturnType<typeof OperationResponse<typeof Memory>>["Type"];
type MemoryIdResponse = ReturnType<typeof OperationResponse<typeof MemoryId>>["Type"];

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
  MemoryResponse,
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
        Effect.mapError((failure) => mapMemoryFailure(failure))
      );
      const stored = yield* insertMemoryInScope(userId, admitted);
      return { data: stored, next: [] };
    })
  );
});

/** Final server-owned facts supplied after canonical decoding and authorization. */
export type ReviseMemoryInput = Readonly<{
  userId: UserId;
  memoryId: MemoryId;
  payload: ReviseInput;
}>;

/**
 * Replaces one current Memory under the User aggregate lock without opening a transaction. The
 * canonical caller owns commit or rollback. Fails with not-found for absent or foreign identity and
 * with capacity-exceeded when the replacement aggregate is inadmissible.
 */
export const reviseMemory: CanonicalMutationImplementation<
  ReviseMemoryInput,
  MemoryResponse,
  MemoryCapacityExceededApi | NotFound,
  HostedInference
> = Effect.fn("reviseMemory")(function* ({ userId, memoryId, payload }) {
  return yield* withUserLockInScope(
    advisoryLockKey.memories(userId),
    Effect.gen(function* () {
      const current = yield* listMemoriesInScope(userId);
      const previous = yield* Option.fromUndefinedOr(
        current.find((memory) => memory.id === memoryId)
      ).pipe(
        Effect.fromOption(() => new MemoryNotFound()),
        Effect.mapError((failure) => mapMemoryFailure(failure))
      );
      const candidate = Memory.make({
        ...previous,
        text: payload.text,
        updatedAt: yield* DateTime.now,
      });
      const admitted = yield* countAndAdmitMemoryRevision(current, candidate).pipe(
        Effect.mapError((failure) => mapMemoryFailure(failure))
      );
      const stored = yield* updateMemoryInScope(userId, admitted).pipe(
        Effect.flatMap(Effect.fromOption(() => new MemoryNotFound())),
        Effect.mapError((failure) => mapMemoryFailure(failure))
      );
      return { data: stored, next: [] };
    })
  );
});

/** Final server-owned facts supplied after canonical decoding and authorization. */
export type ForgetMemoryInput = Readonly<{ userId: UserId; memoryId: MemoryId }>;

/**
 * Physically removes one current Memory under the User aggregate lock without opening a transaction.
 * The canonical caller owns commit or rollback. Fails identically for absent and foreign identity.
 */
export const forgetMemory: CanonicalMutationImplementation<
  ForgetMemoryInput,
  MemoryIdResponse,
  NotFound
> = Effect.fn("forgetMemory")(function* ({ userId, memoryId }) {
  return yield* withUserLockInScope(
    advisoryLockKey.memories(userId),
    deleteMemoryInScope(userId, memoryId).pipe(
      Effect.flatMap(Effect.fromOption(() => new MemoryNotFound())),
      Effect.mapError((failure) => mapMemoryFailure(failure)),
      Effect.map((data) => ({ data, next: [] }))
    )
  );
});
