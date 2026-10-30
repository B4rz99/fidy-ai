import { Effect, Option } from "effect";
import { prepareQuery } from "@/transport/query-preparation";
import { type AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import {
  revalidateWorkspaceQuery,
  workspaceProfileQuery,
  workspaceQueryRetention,
} from "@/transport/workspace-query";
import { currentBudgetMonth } from "./model";
import type { CurrentUser } from "./presentation";

export const budgetStatusQuery = ({
  apiClient,
  user,
  month,
}: Readonly<{
  apiClient: FidyClient;
  user: CurrentUser;
  month: string;
}>): Atom.Atom<AsyncResult.AsyncResult<CanonicalSuccess<"budgets.getBudgetStatus">, unknown>> =>
  apiClient
    .query("budgets", "getBudgetStatus", {
      ...workspaceQueryRetention,
      query: { timeZone: user.timeZone, month },
    })
    .pipe(revalidateWorkspaceQuery);
export const preloadBudgetData = ({
  apiClient,
  registry,
  month,
  signal,
}: Readonly<{
  apiClient: FidyClient;
  registry: AtomRegistry.AtomRegistry;
  month: Option.Option<string>;
  signal: Option.Option<AbortSignal>;
}>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: workspaceProfileQuery(apiClient),
          options: { mode: "cached", signal },
        })
      );
      const profile = presentCanonicalQuery(registry.get(workspaceProfileQuery(apiClient)));
      if (profile._tag !== "Ready" || profile.waiting || Option.isSome(profile.refreshFailure)) {
        return;
      }
      return yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: budgetStatusQuery({
            apiClient,
            user: profile.value.data,
            month: Option.getOrElse(month, () => currentBudgetMonth(profile.value.data)),
          }),
          options: { mode: "display", signal },
        })
      );
    })
  );
