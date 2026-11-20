import type { Option } from "effect";
import type { HttpApiEndpoint } from "effect/http-api";
import type { AccessTier } from "~/core/access-tier/contract";
import type { ProviderQualifiedMessages } from "~/core/consent/contract";
import type { FidyApi, OperationId } from "~/shell/api";
import type { CanonicalCaller } from "~/shell/authorization/contract";

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

export type CanonicalInput<Id extends OperationId> = Omit<
  ClientInput<CanonicalEndpoint<Id>>,
  "responseMode" | "sseOptions"
>;

export type CanonicalSuccess<Id extends OperationId> = HttpApiEndpoint.Success<
  CanonicalEndpoint<Id>
>["Type"];

export type CanonicalImplementationCaller = Readonly<{
  resolved: CanonicalCaller;
  accessTier: AccessTier;
  confirmationEvidence: () => Option.Option<ProviderQualifiedMessages>;
}>;
