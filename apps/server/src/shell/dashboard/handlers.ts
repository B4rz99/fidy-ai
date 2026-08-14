import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { categoryIds } from "~/core/categories/taxonomy";
import { makeDashboardCatalog } from "~/core/dashboard/catalog";
import { type DashboardDocument } from "~/core/dashboard/model";
import { type UserId } from "~/core/identity/reference";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { makeFreeSuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { applyDashboardEdit, loadOrCreateDashboard } from "./mutations";
import { withDashboardLock } from "./repo";

const dashboardCatalog = makeDashboardCatalog({
  restaurantCategoryId: categoryIds.restaurantes,
});

const getDashboard = (
  userId: UserId
): Effect.Effect<DashboardDocument, never, SqlClient.SqlClient> =>
  withDashboardLock(userId, loadOrCreateDashboard(userId));

/** Resolves User ownership before every dashboard read or atomic edit. */
export const DashboardLive = HttpApiBuilder.group(FidyApi, "dashboard", (handlers) =>
  handlers
    .handle("getDashboard", () =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* ResolvedCaller;
        const document = yield* getDashboard(userId);
        return { data: document, next: [] };
      })
    )
    .handle("listDashboardCatalog", () =>
      Effect.gen(function* () {
        yield* ResolvedCaller;
        return { data: dashboardCatalog, next: [] };
      })
    )
    .handle("applyDashboardEdit", ({ payload: edit }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId: userId } = yield* ResolvedCaller;
        return yield* applyDashboardEdit({
          userId,
          edit,
          caller: makeFreeSuggestedOperationCaller(scopes),
        });
      })
    )
);
