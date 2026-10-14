import { CanonicalTelemetry, ValidationGate } from "~/shell/public-http/contract";
import { HttpApi, type HttpApiGroup, OpenApi } from "effect/http-api";
import { TokenAuthorization } from "~/shell/authorization/contract";

import { bindOperationCatalog, makeOperationCatalog } from "~/shell/canonical-catalog/contract";
import { BrowserLoginGroup } from "~/shell/browser-login/contract";
import { BudgetsGroup } from "~/shell/budgets/contract";
import { ConnectionsGroup } from "~/shell/connections/contract";
import { CategoriesGroup } from "~/shell/categories/contract";
import { DashboardGroup } from "~/shell/dashboard/contract";
import { EmailAuthenticationGroup } from "~/shell/email-authentication/contract";
import { IdentityGroup } from "~/shell/identity/contract";
import { RecurringGroup } from "~/shell/recurring/contract";
import { InsightsGroup } from "~/shell/insights/contract";
import { IngestionGroup } from "~/shell/ingestion/contract";
import { MemoryGroup } from "~/shell/memory/contract";
import { makeOperationsGroup } from "~/shell/operations/contract";
import { SubscriptionGroup } from "~/shell/subscription/contract";
import { PATsGroup } from "~/shell/tokens/contract";
import { QuotasGroup } from "~/shell/quotas/contract";
import { RecoveryGroup } from "~/shell/recovery/contract";
import { TransactionsGroup } from "~/shell/transactions/contract";

const OrdinaryFidyApi = HttpApi.make("fidy")
  .add(BrowserLoginGroup)
  .add(IdentityGroup)
  .add(CategoriesGroup)
  .add(BudgetsGroup)
  .add(ConnectionsGroup)
  .add(DashboardGroup)
  .add(EmailAuthenticationGroup)
  .add(TransactionsGroup)
  .add(IngestionGroup)
  .add(InsightsGroup)
  .add(RecurringGroup)
  .add(MemoryGroup)
  .add(SubscriptionGroup)
  .add(QuotasGroup)
  .add(PATsGroup)
  .add(RecoveryGroup);

const ordinaryOperationCatalog = makeOperationCatalog(OrdinaryFidyApi);
const OperationsGroup = makeOperationsGroup(ordinaryOperationCatalog);

export class FidyApi extends OrdinaryFidyApi.add(OperationsGroup)
  // `.middleware` after `.add`, and not the other way round: it attaches to the operations already
  // assembled, so a group added below this line would silently skip every API-wide guard.
  .middleware(ValidationGate)
  // Authorization wraps validation and rejects an unauthenticated request before decoding input.
  .middleware(TokenAuthorization)
  // Telemetry is outermost and observes both authorization failures and canonical execution.
  .middleware(CanonicalTelemetry)
  .annotate(OpenApi.Title, "fidy-ai canonical API") {}

/**
 * Canonical ids, routes, inputs, outputs, failures, and callability policy reflected from the
 * assembled API. Adding or renaming an operation updates every catalog-derived guard and registry.
 */
export const operationCatalog = makeOperationCatalog(FidyApi);

type ApiGroups<Api> = Api extends HttpApi.HttpApi<infer _Identifier, infer Groups> ? Groups : never;

export type FidyApiGroups = ApiGroups<typeof FidyApi>;

type GroupOperationIds<Group> = Group extends HttpApiGroup.Constraint
  ? `${HttpApiGroup.Identifier<Group>}.${HttpApiGroup.Endpoints<Group>["identifier"]}`
  : never;

export type OperationId = GroupOperationIds<ApiGroups<typeof FidyApi>>;

bindOperationCatalog(operationCatalog);
