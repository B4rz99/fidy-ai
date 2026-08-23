import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { User, UserPreferences } from "~/core/identity/model";
import { operationPolicy, patScoped } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

/**
 * Canonical stable-User operations. The update payload is the model-derived
 * preference projection, so ServiceMarket cannot become editable through a
 * second hand-written request schema.
 */
export const IdentityGroup = HttpApiGroup.make("identity").add(
  HttpApiEndpoint.get("getCurrentUser", "/user", {
    success: OperationResponse(User),
  })
    .annotate(
      OpenApi.Description,
      "Get the stable User behind the authenticated bearer and the independently stored ServiceMarket, " +
        "locale, and IANA time zone. Use it before interpreting dates or presenting data to the User."
    )
    .annotateMerge(
      operationPolicy({
        access: patScoped("read"),
        requiredTier: "free",
        agentConfirmation: "not-required",
        kind: "query",
      })
    ),
  HttpApiEndpoint.patch("updateUserPreferences", "/user/preferences", {
    payload: UserPreferences,
    success: OperationResponse(User),
  })
    .annotate(
      OpenApi.Description,
      "Update the User's editable presentation locale and named IANA time zone. Use it when the " +
        "User asks to change either preference; ServiceMarket cannot be changed here."
    )
    .annotateMerge(
      operationPolicy({
        access: patScoped("write"),
        requiredTier: "free",
        agentConfirmation: "not-required",
        kind: "mutation",
      })
    )
);
