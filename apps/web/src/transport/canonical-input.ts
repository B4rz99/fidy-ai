import { type CanonicalInput, type OperationId, operationCatalog } from "@fidy/server/client";
import { Function, Option, Schema } from "effect";

/** Checks a form's decoded input against the canonical operation before attempting a write. */
export const isCanonicalInput: {
  <Id extends OperationId>(input: CanonicalInput<Id>): (operationId: Id) => boolean;
  <Id extends OperationId>(operationId: Id, input: CanonicalInput<Id>): boolean;
} = Function.dual(
  2,
  <Id extends OperationId>(operationId: Id, input: CanonicalInput<Id>): boolean => {
    const operation = Option.getOrThrow(
      Option.fromNullishOr(operationCatalog.byId.get(operationId))
    );
    return Option.isSome(Schema.encodeUnknownOption(operation.input)(input));
  }
);
