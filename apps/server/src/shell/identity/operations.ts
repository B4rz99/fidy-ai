import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { User, UserPreferences } from "~/core/identity/model";
import { operationPolicy, patScoped } from "~/shell/_shared/operation-policy";
import { OperationResponse, Unavailable } from "~/shell/public-http/contract";
import type { FreshSessionSubject } from "./contract";

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

/** Recheck a fresh User-owned WebSession within the same D1 unit as an authority change. */
export const freshSessionExists = `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
  AND fresh_until_ms > ? AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`;

type SessionParams = readonly [string, string, number, number, number];
export const freshSessionParams = ({
  session,
  time,
}: Readonly<{ session: FreshSessionSubject; time: number }>): SessionParams => [
  session.id,
  session.user_id,
  time,
  time,
  time,
];
