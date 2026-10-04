import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RecurringSeriesPage } from "~/core/recurring/contract";
import { operationPolicy, userOwnedAgentScoped } from "~/shell/canonical-policy/contract";
import { OperationResponse, ValidationFailed } from "~/shell/public-http/contract";

const maximumCursorLength = 1024;
/** Browse detected historical monthly charges, not guaranteed active commitments; totals are deliberately absent. */
export const RecurringGroup = HttpApiGroup.make("recurring").add(
  HttpApiEndpoint.get("listRecurringSeries", "/recurring-series", {
    query: Schema.Struct({
      cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(maximumCursorLength))),
    }),
    success: OperationResponse(RecurringSeriesPage),
    error: ValidationFailed,
  })
    .annotate(
      OpenApi.Description,
      "List your detected historical monthly recurring-charge patterns with explicit Currency and latest observed Money. Three unambiguous charges establish a pattern, not an active commitment. Check evaluation status before treating results as complete; follow the cursor for more patterns."
    )
    .annotateMerge(
      operationPolicy({
        access: userOwnedAgentScoped("read"),
        requiredTier: "free",
        agentConfirmation: "not-required",
        kind: "query",
      })
    )
);
