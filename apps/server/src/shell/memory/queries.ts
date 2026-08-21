import { Effect } from "effect";
import type { UserId } from "~/core/identity/reference";
import { selectMemoriesInScope } from "./repo";

/** Recalls the caller's own Memories in the deterministic order the aggregate defines. */
export const recall = Effect.fn("recall")(function* ({ userId }: Readonly<{ userId: UserId }>) {
  return { data: yield* selectMemoriesInScope(userId), next: [] };
});
