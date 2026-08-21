import type { HttpApiEndpoint } from "effect/unstable/httpapi";
import type { FidyApi, OperationId } from "~/shell/api";

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
  "responseMode"
>;
