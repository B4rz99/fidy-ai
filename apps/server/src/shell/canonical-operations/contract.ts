import type { Option } from "effect";
import type { HttpApiEndpoint } from "effect/unstable/httpapi";
import type { AccessTier } from "~/core/access-tier/contract";
import type { ProviderQualifiedMessages } from "~/core/consent/contract";
import type { FidyApi, OperationId } from "~/shell/api";
import type { CanonicalCaller } from "~/shell/authorization/contract";

/** Keeps input and failure projections correlated to the same assembled API declaration. */
export type CanonicalEndpoint<Id extends OperationId> =
  Id extends `${infer Group}.${infer Endpoint}`
    ? Group extends keyof typeof FidyApi.groups
      ? Endpoint extends keyof (typeof FidyApi.groups)[Group]["endpoints"]
        ? (typeof FidyApi.groups)[Group]["endpoints"][Endpoint]
        : never
      : never
    : never;

type ClientInput<Endpoint extends HttpApiEndpoint.ConstraintRequest> = Exclude<
  HttpApiEndpoint.ClientRequest<
    Endpoint["~Params"],
    Endpoint["~Query"],
    Endpoint["~Payload"],
    Endpoint["~Headers"],
    "decoded-only"
  >,
  void
>;

/** Decoded client input selected directly from one canonical `FidyApi` operation. */
export type CanonicalInput<Id extends OperationId> = Omit<
  ClientInput<CanonicalEndpoint<Id>>,
  "responseMode" | "sseOptions"
>;

/** The decoded success value represented by an assembled canonical operation declaration. */
export type CanonicalSuccess<Id extends OperationId> = HttpApiEndpoint.Success<
  CanonicalEndpoint<Id>
>["Type"];

/** Caller facts supplied to every canonical implementation once the executor has resolved one. */
export type CanonicalImplementationCaller = Readonly<{
  resolved: CanonicalCaller;
  accessTier: AccessTier;
  /** Exact provider evidence exposed lazily only after the hosted confirmation permit is consumed. */
  confirmationEvidence: () => Option.Option<ProviderQualifiedMessages>;
}>;
