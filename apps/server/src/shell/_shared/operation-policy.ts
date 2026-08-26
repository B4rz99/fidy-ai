import { Context, Function, Option, Schema, SchemaTransformation } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { CanonicalCapability } from "~/core/_shared/canonical-capability";

/** The Subscription tier a caller currently has or an operation requires. */
export const OperationTier = Schema.Literals(["free", "pro"]);
export type OperationTier = typeof OperationTier.Type;

/** Whether a hosted agent must obtain exact User confirmation before execution. */
export const AgentConfirmation = Schema.Literals(["not-required", "required"]);
export type AgentConfirmation = typeof AgentConfirmation.Type;

/** Whether an operation observes domain state or requests a transition, durable work, or external effect. */
export const CanonicalOperationKind = Schema.Literals(["query", "mutation"]);
export type CanonicalOperationKind = typeof CanonicalOperationKind.Type;

/** The capability checkpoint for a normal PAT call or each child of a canonical batch. */
export const PATScopeCheck = Schema.Union([
  Schema.TaggedStruct("Operation", { capability: CanonicalCapability }),
  Schema.TaggedStruct("Children", {}),
]);
export type PATScopeCheck = typeof PATScopeCheck.Type;

const CanonicalOperationAccess = Schema.Union([
  Schema.TaggedStruct("PATScoped", { scope: PATScopeCheck }),
  Schema.TaggedStruct("FreshWebSessionOnly", {}),
  Schema.TaggedStruct("WebOrHosted", {}),
  Schema.TaggedStruct("VerifiedWhatsAppHostedOnly", {}),
  Schema.TaggedStruct("FreshWebOrVerifiedWhatsAppHosted", {}),
]);

const PublishedOperationAccessWire = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pat-scoped"),
    scope: Schema.Union([
      Schema.Struct({
        evaluation: Schema.Literal("operation"),
        capability: CanonicalCapability,
      }),
      Schema.Struct({ evaluation: Schema.Literal("children") }),
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("fresh-web-session-only") }),
  Schema.Struct({ type: Schema.Literal("web-or-hosted") }),
  Schema.Struct({ type: Schema.Literal("verified-whatsapp-hosted-only") }),
  Schema.Struct({ type: Schema.Literal("fresh-web-or-verified-whatsapp-hosted") }),
]);

type CanonicalOperationAccess = typeof CanonicalOperationAccess.Type;
type PublishedOperationAccessWire = typeof PublishedOperationAccessWire.Type;

const decodePublishedAccess = (access: PublishedOperationAccessWire): CanonicalOperationAccess => {
  switch (access.type) {
    case "pat-scoped":
      return {
        _tag: "PATScoped",
        scope:
          access.scope.evaluation === "operation"
            ? { _tag: "Operation", capability: access.scope.capability }
            : { _tag: "Children" },
      };
    case "fresh-web-session-only":
      return { _tag: "FreshWebSessionOnly" };
    case "web-or-hosted":
      return { _tag: "WebOrHosted" };
    case "verified-whatsapp-hosted-only":
      return { _tag: "VerifiedWhatsAppHostedOnly" };
    case "fresh-web-or-verified-whatsapp-hosted":
      return { _tag: "FreshWebOrVerifiedWhatsAppHosted" };
  }
};

const encodePublishedAccess = (access: CanonicalOperationAccess): PublishedOperationAccessWire => {
  switch (access._tag) {
    case "PATScoped":
      return {
        type: "pat-scoped",
        scope:
          access.scope._tag === "Operation"
            ? { evaluation: "operation", capability: access.scope.capability }
            : { evaluation: "children" },
      };
    case "FreshWebSessionOnly":
      return { type: "fresh-web-session-only" };
    case "WebOrHosted":
      return { type: "web-or-hosted" };
    case "VerifiedWhatsAppHostedOnly":
      return { type: "verified-whatsapp-hosted-only" };
    case "FreshWebOrVerifiedWhatsAppHosted":
      return { type: "fresh-web-or-verified-whatsapp-hosted" };
  }
};

/** One codec deriving canonical operation access from its public metadata representation. */
export const OperationAccess = PublishedOperationAccessWire.pipe(
  Schema.decodeTo(
    CanonicalOperationAccess,
    SchemaTransformation.transform({
      decode: decodePublishedAccess,
      encode: encodePublishedAccess,
    })
  )
);
export type OperationAccess = typeof OperationAccess.Type;

/** Public encoded side of the canonical operation-access codec. */
export const PublishedOperationAccess = Schema.toEncoded(OperationAccess);
export type PublishedOperationAccess = typeof PublishedOperationAccess.Type;

/** Non-credential provenance retained across a hosted Turn for caller access. */
export type CanonicalAuthorityRoot = "verified-whatsapp" | "no-verified-whatsapp-authority";

/** The caller facts the access module needs, without identity or credential material. */
export type OperationAccessCaller =
  | Readonly<{ _tag: "PAT"; capabilities: ReadonlyArray<CanonicalCapability> }>
  | Readonly<{ _tag: "WebSession"; fresh: boolean }>
  | Readonly<{
      _tag: "HostedAgentSession";
      authorityRoot: CanonicalAuthorityRoot;
    }>;

/** Closed reason vocabulary returned when a caller fails an access requirement. */
export type OperationAccessDenial =
  | "pat_scope_missing"
  | "fresh_web_session_required"
  | "caller_ineligible";

/** Authoritative execution and discovery result for one operation and caller. */
export type OperationAccessDecision =
  | Readonly<{ _tag: "Allowed" }>
  | Readonly<{ _tag: "Denied"; reason: OperationAccessDenial }>;

/** Declares an operation-level PAT capability while admitting web and hosted callers. */
export const patScoped = (capability: CanonicalCapability): OperationAccess => ({
  _tag: "PATScoped",
  scope: { _tag: "Operation", capability },
});

/** Declares that the canonical atomic batch evaluates every child's PAT capability. */
export const patScopedChildren: OperationAccess = {
  _tag: "PATScoped",
  scope: { _tag: "Children" },
};

/** Declares an operation available only to a currently fresh WebSession. */
export const freshWebSessionOnly: OperationAccess = { _tag: "FreshWebSessionOnly" };

/** Declares an operation available to web and hosted callers but never PAT callers. */
export const webOrHosted: OperationAccess = { _tag: "WebOrHosted" };

/** Declares an operation available only under verified WhatsApp hosted authority. */
export const verifiedWhatsAppHostedOnly: OperationAccess = {
  _tag: "VerifiedWhatsAppHostedOnly",
};

/** Declares account-security work available to fresh web or verified-WhatsApp hosted authority. */
export const freshWebOrVerifiedWhatsAppHosted: OperationAccess = {
  _tag: "FreshWebOrVerifiedWhatsAppHosted",
};

const allowed: OperationAccessDecision = { _tag: "Allowed" };
const denied = (reason: OperationAccessDenial): OperationAccessDecision => ({
  _tag: "Denied",
  reason,
});

const decidePatCapability = (
  capability: CanonicalCapability,
  capabilities: ReadonlyArray<CanonicalCapability>
): OperationAccessDecision =>
  capabilities.includes(capability) ? allowed : denied("pat_scope_missing");

const decidePATScope = (
  scope: PATScopeCheck,
  capabilities: ReadonlyArray<CanonicalCapability>
): OperationAccessDecision => {
  if (scope._tag === "Children") return allowed;
  return decidePatCapability(scope.capability, capabilities);
};

const decidePATScoped = (
  requirement: Extract<OperationAccess, { readonly _tag: "PATScoped" }>,
  caller: OperationAccessCaller
): OperationAccessDecision => {
  if (caller._tag !== "PAT") return allowed;
  return decidePATScope(requirement.scope, caller.capabilities);
};

const decideFreshWebSession = (caller: OperationAccessCaller): OperationAccessDecision => {
  if (caller._tag !== "WebSession") return denied("caller_ineligible");
  return caller.fresh ? allowed : denied("fresh_web_session_required");
};

const decideHostedAuthority = (authorityRoot: CanonicalAuthorityRoot): OperationAccessDecision =>
  authorityRoot === "verified-whatsapp" ? allowed : denied("caller_ineligible");

const decideVerifiedWhatsAppHosted = (caller: OperationAccessCaller): OperationAccessDecision => {
  if (caller._tag !== "HostedAgentSession") return denied("caller_ineligible");
  return decideHostedAuthority(caller.authorityRoot);
};

/** Decides execution from the same closed requirement used by every derived surface. */
export const decideOperationAccess: {
  (caller: OperationAccessCaller): (self: OperationAccess) => OperationAccessDecision;
  (self: OperationAccess, caller: OperationAccessCaller): OperationAccessDecision;
} = Function.dual(2, (requirement: OperationAccess, caller: OperationAccessCaller) => {
  switch (requirement._tag) {
    case "PATScoped":
      return decidePATScoped(requirement, caller);
    case "FreshWebSessionOnly":
      return decideFreshWebSession(caller);
    case "WebOrHosted":
      return caller._tag === "PAT" ? denied("caller_ineligible") : allowed;
    case "VerifiedWhatsAppHostedOnly":
      return decideVerifiedWhatsAppHosted(caller);
    case "FreshWebOrVerifiedWhatsAppHosted":
      return caller._tag === "WebSession"
        ? decideFreshWebSession(caller)
        : decideVerifiedWhatsAppHosted(caller);
  }
});

const encodeOperationAccess = Schema.encodeSync(OperationAccess);

/** Encodes canonical access into the metadata carried by OpenAPI and policy evidence. */
export const publishOperationAccess = (access: OperationAccess): PublishedOperationAccess =>
  encodeOperationAccess(access);

/** Whether an operation carries PAT scope policy and may therefore be an atomic-batch child. */
export const isPATScoped = (access: OperationAccess): boolean => access._tag === "PATScoped";

const scopeCapability = (scope: PATScopeCheck): Option.Option<CanonicalCapability> =>
  scope._tag === "Operation" ? Option.some(scope.capability) : Option.none();

/** Returns the operation-level PAT capability, excluding child-evaluated and non-PAT access. */
export const patScopeCapability = (access: OperationAccess): Option.Option<CanonicalCapability> => {
  if (access._tag !== "PATScoped") return Option.none();
  return scopeCapability(access.scope);
};

/** Whether a hosted caller with the given authority may discover this operation as a tool. */
export const isHostedVisible: {
  (authorityRoot: CanonicalAuthorityRoot): (self: OperationAccess) => boolean;
  (self: OperationAccess, authorityRoot: CanonicalAuthorityRoot): boolean;
} = Function.dual(
  2,
  (access: OperationAccess, authorityRoot: CanonicalAuthorityRoot): boolean =>
    decideOperationAccess(access, { _tag: "HostedAgentSession", authorityRoot })._tag === "Allowed"
);

/** Route-independent authorization, availability, accounting, and agent policy carried by an operation. */
export type OperationPolicyValue = {
  readonly access: OperationAccess;
  readonly requiredTier: OperationTier;
  readonly agentConfirmation: AgentConfirmation;
  readonly kind: CanonicalOperationKind;
};

/** Whether a successful hosted tool call completes the Turn without another model round. */
export const completesHostedTurn = (policy: OperationPolicyValue): boolean => {
  if (policy.kind !== "mutation") return false;
  if (policy.access._tag === "PATScoped") {
    return policy.access.scope._tag === "Operation" && policy.access.scope.capability === "write";
  }
  return policy.access._tag !== "FreshWebSessionOnly";
};

/** Annotation key read by shared authorization from the active endpoint. */
export class OperationPolicy extends Context.Service<OperationPolicy, OperationPolicyValue>()(
  "@fidy/server/shell/_shared/operation-policy/OperationPolicy"
) {}

type PolicyAnnotatedOperation = {
  readonly annotations: Context.Context<never>;
};

/**
 * Reads the complete policy directly from one canonical operation definition.
 * The caller must pass an endpoint carrying `operationPolicy`; absence is a
 * programmer defect and throws rather than silently granting a default policy.
 */
export const getOperationPolicy = (endpoint: PolicyAnnotatedOperation): OperationPolicyValue =>
  Option.getOrThrow(Context.getOption(endpoint.annotations, OperationPolicy));

/**
 * Builds runtime policy and public metadata together from one complete declaration, so no caller
 * surface can infer access from an independent scope or eligibility field.
 */
export const operationPolicy = (
  policy: OperationPolicyValue
): Context.Context<OperationPolicy | OpenApi.Override> =>
  Context.make(OperationPolicy, policy).pipe(
    Context.add(OpenApi.Override, {
      "x-fidy-access": publishOperationAccess(policy.access),
      "x-fidy-required-tier": policy.requiredTier,
      "x-fidy-agent-confirmation": policy.agentConfirmation,
      "x-fidy-operation-kind": policy.kind,
    })
  );
