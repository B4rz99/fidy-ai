import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { RecurringDetectionOutcome, RecurringSeriesReport } from "~/core/recurring/model";
import { operationPolicy } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

const read = operationPolicy({
  requiredScope: "read",
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});
const detect = operationPolicy({
  requiredScope: "write",
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});

/** Canonical detection and read-back of the caller's repeating charges. */
export const RecurringGroup = HttpApiGroup.make("recurring")
  .add(
    HttpApiEndpoint.get("listRecurringSeries", "/recurring-series", {
      success: OperationResponse(RecurringSeriesReport),
    })
      .annotate(
        OpenApi.Description,
        "Answer what recurring charges the caller has. Results arrive grouped by explicit " +
          "Currency, each group carrying what one occurrence of its series costs. Nothing is " +
          "converted between Currencies, so read each group on its own rather than adding them."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.post("detectRecurringSeries", "/recurring-series/detection", {
      success: OperationResponse(RecurringDetectionOutcome),
    })
      .annotate(
        OpenApi.Description,
        "Re-examine the caller's whole Transaction history and record the repeating charges it " +
          "confirms. `confirmed` holds only the series fidy had not recorded before, and " +
          "`announcement` is the Currency-grouped Money worth telling the user about, leaving " +
          "out series held back as backfill or cold-start. Reach for this after importing a " +
          "statement or logging several movements; listing series does not run detection itself."
      )
      .annotateMerge(detect)
  );
