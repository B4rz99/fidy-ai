import type { Effect } from "effect";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { User, UserPreferences } from "~/core/identity/contract";
import { operationPolicy, patScoped } from "~/shell/canonical-policy/contract";
import { OperationResponse, Unavailable } from "~/shell/public-http/contract";

/**
 * Canonical stable-User operations. The update payload is the model-derived
 * preference projection, so ServiceMarket cannot become editable through a
 * second hand-written request schema.
 */
export const IdentityGroup = HttpApiGroup.make("identity").add(
  HttpApiEndpoint.get("getCurrentUser", "/user", {
    success: OperationResponse(User),
    error: Unavailable,
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

/** Complete canonical User projection, including the original TrialPeriod and no suggested work. */
export type CurrentUserResponse = Readonly<{ data: User; next: ReadonlyArray<never> }>;

/**
 * One User's canonical read with current Consent grant checked when its statement executes.
 * Decode only that statement's result; absent, malformed or foreign-User state is unavailable. The caller must
 * retain its authenticated User and recheck credential authority before releasing the projection.
 */
export type PreparedCurrentUserRead = Readonly<{
  statement: OwnedStatement;
  decode: (rows: ReadonlyArray<unknown>) => Effect.Effect<CurrentUserResponse, Unavailable>;
}>;
