import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { DashboardCatalog, DashboardDocument, DashboardEdit } from "~/core/dashboard/model";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { operationPolicy } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

const DashboardEditFailures = [NotFound, ValidationFailed] as const;

/** Canonical contract for the caller's one persistent DashboardDocument. */
export const DashboardGroup = HttpApiGroup.make("dashboard")
  .add(
    HttpApiEndpoint.get("getDashboard", "/dashboard", {
      success: OperationResponse(DashboardDocument),
    })
      .annotate(
        OpenApi.Description,
        "Get the caller's complete DashboardDocument. Reach for this before editing or rendering " +
          "the dashboard; first use creates and retains one valid spending widget, and every " +
          "later call returns the same latest document."
      )
      .annotateMerge(
        operationPolicy({ requiredScope: "read", requiredTier: "free", costClass: "cheap" })
      )
  )
  .add(
    HttpApiEndpoint.get("listDashboardCatalog", "/dashboard/catalog", {
      success: OperationResponse(DashboardCatalog),
    })
      .annotate(
        OpenApi.Description,
        "List the four valid direct-launch widget presets shared by the web UI and agents. " +
          "Choose a template, assign a fresh UUID as its WidgetId, then send it through " +
          "dashboard.applyDashboardEdit with add-widget."
      )
      .annotateMerge(
        operationPolicy({ requiredScope: "read", requiredTier: "free", costClass: "cheap" })
      )
  )
  .add(
    HttpApiEndpoint.post("applyDashboardEdit", "/dashboard/edits", {
      payload: DashboardEdit,
      success: OperationResponse(DashboardDocument),
      error: DashboardEditFailures,
    })
      .annotate(
        OpenApi.Description,
        "Apply one structural DashboardEdit to the caller's latest locked document. Use the same " +
          "add, remove, move, resize, replace, or title edit the web UI uses; invalid edits and " +
          "invalid resulting documents leave the stored dashboard unchanged."
      )
      .annotateMerge(
        operationPolicy({ requiredScope: "dashboard", requiredTier: "free", costClass: "cheap" })
      )
  );
