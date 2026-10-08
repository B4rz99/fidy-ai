import { UtcTimestamp } from "~/core/_shared/time";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  ConnectInstitutionInput,
  ConnectInstitutionResult,
  Connection,
  ConnectionId,
  InstitutionSummary,
} from "~/core/connections/contract";
import { NotFound, OperationResponse, ValidationFailed } from "~/shell/public-http/contract";
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

/** Discover institutions, initiate browser authorization, and inspect caller-owned Connections. */
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
  );

/** Public locator only; possession never establishes User or institution authority. */
export const ConnectionAttemptReference = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("ConnectionAttemptReference"))
  .annotate({ identifier: "ConnectionAttemptReference" });

export const ConnectionContinuationInput = Schema.Struct({ attempt: ConnectionAttemptReference });

/** Safe same-User continuation facts, with the original absolute deadline. */
export const ConnectionContinuationReview = Schema.Struct({
  connection: Connection,
  institutionName: Schema.Literal("Bancolombia"),
  expiresAt: UtcTimestamp,
  phase: Schema.Literals(["ready", "prepared"]),
});

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
  limited: 429,
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
        error: browserFailures,
      })
    )
    .add(
      HttpApiEndpoint.post("begin", connectionBrowserPaths.begin, {
        payload: ConnectionContinuationInput,
        success: ConnectionContinuationReview,
        error: browserFailures,
      })
    )
);
