import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { User, UserPreferences } from "~/core/identity/model";
import { operationPolicy, patScoped } from "~/shell/_shared/operation-policy";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { OperationResponse, Unavailable } from "~/shell/public-http/contract";

/**
 * Embed one resolved User's original TrialPeriod activity in the caller's D1 unit. The UTC
 * decision instant is inclusive at the start and exclusive at the end. This grants no caller
 * authority, performs no write, and must be composed with the caller's own authorization guard.
 */
export const activeTrialPredicate = ({
  userId,
  nowEpochMs,
}: Readonly<{ userId: string; nowEpochMs: number }>): OwnedStatement => ({
  sql: `EXISTS (SELECT 1 FROM trial_periods AS trial
    WHERE trial.user_id = ? AND trial.started_at_ms <= ? AND trial.ends_at_ms > ?)`,
  params: [userId, nowEpochMs, nowEpochMs],
});

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
