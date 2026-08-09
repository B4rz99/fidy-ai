import { HttpApi, type HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { AgentAuthorization } from "~/shell/_shared/authz";
import { CanonicalTelemetry } from "~/shell/_shared/canonical-telemetry";
import { ValidationGate } from "~/shell/_shared/errors";
import { bindOperationCatalog, makeOperationCatalog } from "~/shell/_shared/operation-catalog";
import { CategoriesGroup } from "~/shell/categories/operations";
import { DashboardGroup } from "~/shell/dashboard/operations";
import { IdentityGroup } from "~/shell/identity/operations";
import { InsightsGroup } from "~/shell/insights/operations";
import { makeOperationsGroup } from "~/shell/operations/operations";
import { TransactionsGroup } from "~/shell/transactions/operations";

const OrdinaryFidyApi = HttpApi.make("fidy")
  .add(IdentityGroup)
  .add(CategoriesGroup)
  .add(DashboardGroup)
  .add(TransactionsGroup)
  .add(InsightsGroup);

// The child union is reflected before the batch group exists, so queries and recursive batches are
// absent by construction. The live dispatch layer checks registry completeness at startup.
const ordinaryOperationCatalog = makeOperationCatalog(OrdinaryFidyApi);
const OperationsGroup = makeOperationsGroup(ordinaryOperationCatalog);

/**
 * The whole canonical API: every slice's operations under one definition, each of them behind the
 * validation, authorization, and telemetry seams. This is the single declaration the server, typed
 * client, and OpenAPI spec derive from, so a future operation cannot bypass those boundaries.
 */
export class FidyApi extends OrdinaryFidyApi.add(OperationsGroup)
  // `.middleware` after `.add`, and not the other way round: it attaches to the operations already
  // assembled, so a group added below this line would silently skip every API-wide guard.
  .middleware(ValidationGate)
  // Authorization wraps validation and rejects an unauthenticated request before decoding input.
  .middleware(AgentAuthorization)
  // Telemetry is outermost and observes both authorization failures and canonical execution.
  .middleware(CanonicalTelemetry)
  .annotate(OpenApi.Title, "fidy-ai canonical API") {}

/**
 * Canonical ids, routes, inputs, outputs, failures, and callability policy reflected from the
 * assembled API. Adding or renaming an operation updates every catalog-derived guard and registry.
 */
export const operationCatalog = makeOperationCatalog(FidyApi);

type ApiGroups<Api> = Api extends HttpApi.HttpApi<infer _Identifier, infer Groups> ? Groups : never;

type GroupOperationIds<Group> = Group extends HttpApiGroup.Constraint
  ? `${HttpApiGroup.Identifier<Group>}.${HttpApiGroup.Endpoints<Group>["identifier"]}`
  : never;

/**
 * Every group-qualified canonical operation identifier derived from the assembled API. A new slice
 * or operation widens the union, while a rename fails at every site that names the old identity.
 * This cross-slice identity lives beside assembly because suggested operations may target any slice.
 */
export type OperationId = GroupOperationIds<ApiGroups<typeof FidyApi>>;

bindOperationCatalog(operationCatalog);
