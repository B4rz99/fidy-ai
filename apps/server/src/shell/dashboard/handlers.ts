import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { resolveFreeSuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { applyDashboardEdit, getDashboard } from "./mutations";
import { listDashboardCatalog } from "./queries";
import { getDashboardView } from "./view";

/** Resolves User ownership before every dashboard read or atomic edit. */
export const DashboardLive = HttpApiBuilder.group(FidyApi, "dashboard", (handlers) =>
  handlers
    .handle("getDashboard", () =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* ResolvedCaller;
        return yield* getDashboard({ userId });
      })
    )
    .handle("getDashboardView", () =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* ResolvedCaller;
        return yield* getDashboardView({ userId });
      })
    )
    .handle("listDashboardCatalog", () =>
      Effect.gen(function* () {
        yield* ResolvedCaller;
        return yield* listDashboardCatalog;
      })
    )
    .handle("applyDashboardEdit", ({ payload: edit }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* applyDashboardEdit({
          userId,
          edit,
          caller,
        });
      })
    )
);
