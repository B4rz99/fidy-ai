import { UtcTimestamp } from "~/core/_shared/time";
import { Context, Schema } from "effect";
import type { InstitutionId } from "~/core/connections/contract";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  Account,
  ConnectInstitutionInput,
  ConnectInstitutionResult,
  Connection,
  ConnectionId,
  InstitutionSummary,
} from "~/core/connections/contract";
import {
  NotFound,
  OperationResponse,
  ResourceLimited,
  ValidationFailed,
} from "~/shell/public-http/contract";
import { operationPolicy, userOwnedAgentScoped } from "~/shell/canonical-policy/contract";

const read = operationPolicy({
  access: userOwnedAgentScoped("read"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});
const write = operationPolicy({
  access: userOwnedAgentScoped("write"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});

export const ConnectionsGroup = HttpApiGroup.make("connections")
  .add(
    HttpApiEndpoint.get("listInstitutions", "/institutions", {
      success: OperationResponse(Schema.Array(InstitutionSummary)),
    })
      .annotate(
        OpenApi.Description,
        "Discover Fidy institutions, availability, and your current Connection state without exposing integration details."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.post("connectInstitution", "/connections", {
      payload: ConnectInstitutionInput,
      success: OperationResponse(ConnectInstitutionResult),
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Create or reuse your stable Connection and a ten-minute browser authorization attempt. Reuse a live attempt; an Active Connection returns already connected. This operation grants no institution authority."
      )
      .annotateMerge(write)
  )
  .add(
    HttpApiEndpoint.get("listConnections", "/connections", {
      success: OperationResponse(Schema.Array(Connection)),
    })
      .annotate(OpenApi.Description, "List your Connections and their product lifecycle states.")
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("getConnection", "/connections/:id", {
      params: Schema.Struct({ id: ConnectionId }),
      success: OperationResponse(Connection),
      error: NotFound,
    })
      .annotate(OpenApi.Description, "Inspect one caller-owned Connection by stable identity.")
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("listAccounts", "/connections/:id/accounts", {
      params: Schema.Struct({ id: ConnectionId }),
      success: OperationResponse(Schema.Array(Account)),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "List the stable Accounts currently authorized through your Connection. Historical Transactions and Balances may still be pending."
      )
      .annotateMerge(read)
  );

/** Public locator only; possession never establishes User or institution authority. */
export const ConnectionAttemptReference = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("ConnectionAttemptReference"))
  .annotate({ identifier: "ConnectionAttemptReference" });

export const ConnectionContinuationInput = Schema.Struct({ attempt: ConnectionAttemptReference });

const maximumAuthorizationUrlLength = 4096;
const AuthorizationUrl = Schema.String.check(
  Schema.isBetweenLength(1, maximumAuthorizationUrlLength),
  Schema.isPattern(/^https:\/\/auth1-api-open-finance-sandbox\.ambientesbc\.com\/auth\?[^#]*$/u),
  Schema.makeFilter((value) => {
    const query = new URL(value).searchParams;
    return (
      query.size === 4 &&
      query.get("response_type") === "code" &&
      query.get("scope") === "accounts" &&
      /^[0-9a-f-]{36}$/u.test(query.get("client_id") ?? "") &&
      /^urn:ietf:params:oauth:request_uri:[A-Za-z0-9_-]{1,256}$/u.test(
        query.get("request_uri") ?? ""
      )
    );
  })
);

export const ConnectionAuthorizationHandoff = Schema.Struct({
  url: AuthorizationUrl,
  expiresAt: UtcTimestamp,
});

/** Safe same-User continuation facts, with the original absolute deadline. */
const continuationFields = {
  connection: Connection,
  institutionName: Schema.Literal("Bancolombia"),
  expiresAt: UtcTimestamp,
};
export const ConnectionContinuationReview = Schema.Union([
  Schema.Struct({
    ...continuationFields,
    phase: Schema.Literals(["ready", "preparing", "failed"]),
    authorization: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    ...continuationFields,
    phase: Schema.Literal("prepared"),
    authorization: Schema.optionalKey(ConnectionAuthorizationHandoff),
  }),
]).check(
  Schema.makeFilter(
    (value) =>
      value.authorization === undefined ||
      value.authorization.expiresAt.epochMilliseconds <= value.expiresAt.epochMilliseconds
  )
);

export const connectionBrowserPaths = {
  review: "/web/connections/review",
  begin: "/web/connections/begin",
} as const;

/** Bounded failure envelope: no locator, credential, or provider detail is reflected. */
export const ConnectionContinuationFailure = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal("continuation_unavailable") }),
});
const browserFailureStatuses = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  missing: 404,
  method: 405,
  unavailable: 503,
} as const;
const browserFailures = Object.values(browserFailureStatuses).map((status) =>
  ConnectionContinuationFailure.pipe(HttpApiSchema.status(status))
);

/** Browser-only continuation; excluded from canonical tools and atomic batches. */
export const ConnectionBrowserApi = HttpApi.make("ConnectionBrowserApi").add(
  HttpApiGroup.make("connectionBrowser")
    .add(
      HttpApiEndpoint.get("review", connectionBrowserPaths.review, {
        query: ConnectionContinuationInput,
        success: ConnectionContinuationReview,
        error: [...browserFailures, ResourceLimited],
      })
    )
    .add(
      HttpApiEndpoint.post("begin", connectionBrowserPaths.begin, {
        payload: ConnectionContinuationInput,
        success: ConnectionContinuationReview,
        error: [...browserFailures, ResourceLimited],
      })
    )
);

/** Only implementations satisfying SupportedInstitution may be registered. None currently qualify. */
export const registeredConnectionInstitutionIds: ReadonlyArray<InstitutionId> = [];

/** Code-composed supported integration registration; transport data cannot supply this service. */
export const ConnectionInstitutions = Context.Reference<ReadonlyArray<InstitutionId>>(
  "@fidy/server/connections/Institutions",
  { defaultValue: () => registeredConnectionInstitutionIds }
);
