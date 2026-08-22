import type { HttpApiEndpoint } from "effect/unstable/httpapi";
import type { OperationId } from "~/shell/api";
import type { CanonicalEndpoint } from "./canonical-input";

/** The decoded success value represented by an assembled canonical operation declaration. */
export type CanonicalSuccess<Id extends OperationId> = HttpApiEndpoint.Success<
  CanonicalEndpoint<Id>
>["Type"];
