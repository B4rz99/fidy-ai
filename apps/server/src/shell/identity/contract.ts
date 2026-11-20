import { Schema } from "effect";
import { Category } from "~/core/categories/contract";
import type { Effect } from "effect";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { User, UserPreferences } from "~/core/identity/contract";
import { operationPolicy, userOwnedAgentScoped } from "~/shell/canonical-policy/contract";
import { OperationResponse, Unavailable } from "~/shell/public-http/contract";

export const CurrentUserMetadata = Schema.Struct({
  ...OperationResponse(User).fields,
  categories: Schema.OptionFromOptionalKey(Schema.Array(Category)),
}).annotate({ identifier: "CurrentUserMetadata" });

export const IdentityGroup = HttpApiGroup.make("identity").add(
  HttpApiEndpoint.get("getCurrentUser", "/user", {
    success: CurrentUserMetadata,
    error: Unavailable,
  })
    .annotate(
      OpenApi.Description,
      "Get the stable User behind the authenticated bearer and the independently stored ServiceMarket, " +
        "locale, and IANA time zone. Browser responses include the bounded Category display catalog so navigation does not require another metadata read. Use it before interpreting dates or presenting data to the User."
    )
    .annotateMerge(
      operationPolicy({
        access: userOwnedAgentScoped("read"),
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
        access: userOwnedAgentScoped("write"),
        requiredTier: "free",
        agentConfirmation: "not-required",
        kind: "mutation",
      })
    )
);

export type CurrentUserResponse = Readonly<{ data: User; next: ReadonlyArray<never> }>;

export type PreparedCurrentUserRead = Readonly<{
  statement: OwnedStatement;
  decode: (rows: ReadonlyArray<unknown>) => Effect.Effect<CurrentUserResponse, Unavailable>;
}>;
