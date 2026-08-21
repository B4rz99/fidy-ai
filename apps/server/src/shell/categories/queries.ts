import { Effect } from "effect";
import type { UserId } from "~/core/identity/reference";
import { selectCategories, selectKeywordRules } from "./repo";

/** Reads the public Category taxonomy, which is the same for every caller. */
export const listCategories = Effect.fn("listCategories")(function* () {
  return { data: yield* selectCategories, next: [] };
});

/** Reads the caller's own keyword rules. */
export const listKeywordRules = Effect.fn("listKeywordRules")(function* ({
  userId,
}: Readonly<{ userId: UserId }>) {
  return { data: yield* selectKeywordRules(userId), next: [] };
});
