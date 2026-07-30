import { HttpApi, type HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { AgentAuthorization } from "~/shell/_shared/authz";
import { ValidationGate } from "~/shell/_shared/errors";
import { bindOperationCatalog, makeOperationCatalog } from "~/shell/_shared/operation-catalog";
import { IdentityGroup } from "~/shell/identity/operations";
import { TransactionsGroup } from "~/shell/transactions/operations";

/**
 * The whole canonical API: every slice's operations under one definition, each
 * of them behind the validation gate. This is the single declaration the server,
 * the typed client and the OpenAPI spec are all derived from, so anything a
 * caller can reach is reachable from here.
 */
export class FidyApi extends HttpApi.make("fidy")
  .add(IdentityGroup)
  .add(TransactionsGroup)
  // `.middleware` after `.add`, and not the other way round: it attaches to
  // the operations already assembled, so a group added below this line would
  // silently skip the gate and answer a rejected request with a bodyless 400.
  .middleware(ValidationGate)
  // Authorization is attached last so it wraps validation and rejects an
  // unauthenticated request before decoding operation input.
  .middleware(AgentAuthorization)
  .annotate(OpenApi.Title, "fidy-ai canonical API") {}

/** Canonical ids, partial inputs, and callability policy reflected from `FidyApi`. */
export const operationCatalog = makeOperationCatalog(FidyApi);
bindOperationCatalog(operationCatalog);

type ApiGroups<Api> = Api extends HttpApi.HttpApi<infer _Identifier, infer Groups> ? Groups : never;

type GroupOperationIds<Group> = Group extends HttpApiGroup.Constraint
  ? `${HttpApiGroup.Identifier<Group>}.${HttpApiGroup.Endpoints<Group>["identifier"]}`
  : never;

/**
 * Canonical operation ids, exactly as every generator exposes them
 * ("<group>.<operation>"). Derived from the assembled API rather than from a
 * list of groups, so both a new operation and a whole new slice widen this union
 * on their own — and a renamed operation is a compile error at every site that
 * names it. The identity binding, and what the derived guards enumerate.
 *
 * It lives beside the assembly rather than in a slice because a suggested operation
 * may point at any operation the API publishes, not only its own slice's.
 */
export type OperationId = GroupOperationIds<ApiGroups<typeof FidyApi>>;
