import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { forgetMemory, rememberMemory, reviseMemory } from "./mutations";
import { listMemoriesInScope } from "./repo";

/** Provides caller-owned Memory creation, replacement, deletion, and deterministic recall. */
export const MemoryLive = HttpApiBuilder.group(FidyApi, "memory", (handlers) =>
  handlers
    .handle("remember", ({ payload }) =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return yield* rememberMemory({ userId: subjectUserId, payload });
      })
    )
    .handle("revise", ({ params, payload }) =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return yield* reviseMemory({
          userId: subjectUserId,
          memoryId: params.id,
          payload,
        });
      })
    )
    .handle("forget", ({ params }) =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return yield* forgetMemory({ userId: subjectUserId, memoryId: params.id });
      })
    )
    .handle("recall", () =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        const memories = yield* listMemoriesInScope(subjectUserId);
        return { data: memories, next: [] };
      })
    )
);
