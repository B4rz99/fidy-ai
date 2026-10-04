import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { QuotaStatus } from "~/core/quotas/contract";
import { operationPolicy, patScoped } from "~/shell/canonical-policy/contract";
import { OperationResponse, Unavailable } from "~/shell/public-http/contract";

/** Observe independent Free meters; inspection remains callable when the canonical-call meter is exhausted. */
export const QuotasGroup = HttpApiGroup.make("quota").add(
  HttpApiEndpoint.get("getQuota", "/quota", {
    success: OperationResponse(QuotaStatus),
    error: Unavailable,
  })
    .annotate(
      OpenApi.Description,
      "Read your four independent Free allowances and exact America/Bogota month reset. This query consumes no canonical unit and remains available at zero remaining; Trial and Pro are uncapped."
    )
    .annotateMerge(
      operationPolicy({
        access: patScoped("read"),
        requiredTier: "free",
        agentConfirmation: "not-required",
        kind: "query",
      })
    )
);
