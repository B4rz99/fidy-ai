import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
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
