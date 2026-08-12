import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { rememberMemory } from "./mutations";
import { listMemoriesInScope } from "./repo";

/** Provides caller-owned explicit Memory creation and complete deterministic recall. */
export const MemoryLive = HttpApiBuilder.group(FidyApi, "memory", (handlers) =>
  handlers
    .handle("remember", ({ payload }) =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return yield* rememberMemory({ userId: subjectUserId, payload });
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
