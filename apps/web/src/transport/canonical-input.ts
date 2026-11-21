import { type CanonicalInput, type OperationId, operationCatalog } from "@fidy/server/client";
import { Function, Option, Schema } from "effect";

export const isCanonicalInput: {
  <Id extends OperationId>(input: CanonicalInput<Id>): (operationId: Id) => boolean;
  <Id extends OperationId>(operationId: Id, input: CanonicalInput<Id>): boolean;
} = Function.dual(
  2,
  <Id extends OperationId>(operationId: Id, input: CanonicalInput<Id>): boolean =>
    Option.match(Option.fromNullishOr(operationCatalog.byId.get(operationId)), {
      onNone: () => false,
      onSome: (operation) => Option.isSome(Schema.encodeUnknownOption(operation.input)(input)),
    })
);
