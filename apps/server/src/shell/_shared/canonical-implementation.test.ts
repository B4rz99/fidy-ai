import { it } from "@effect/vitest";
import { type Effect } from "effect";
import { expectTypeOf } from "vitest";
import type {
  CanonicalImplementationRequirements,
  CanonicalOperationImplementations,
} from "./canonical-implementation";

type DeclaredImplementation = CanonicalOperationImplementations["transactions.getTransaction"];
type UndeclaredSuccess = Readonly<{ readonly undeclared: true }>;
type WrongSuccessImplementation = (
  input: Parameters<DeclaredImplementation>[0],
  caller: Parameters<DeclaredImplementation>[1]
) => Effect.Effect<
  UndeclaredSuccess,
  Effect.Error<ReturnType<DeclaredImplementation>>,
  CanonicalImplementationRequirements
>;
type AcceptsWrongSuccess = [WrongSuccessImplementation] extends [DeclaredImplementation]
  ? true
  : false;

type UndeclaredFailure = Readonly<{ readonly _tag: "UndeclaredFailure" }>;
type WidenedImplementation = (
  input: Parameters<DeclaredImplementation>[0],
  caller: Parameters<DeclaredImplementation>[1]
) => Effect.Effect<
  Effect.Success<ReturnType<DeclaredImplementation>>,
  Effect.Error<ReturnType<DeclaredImplementation>> | UndeclaredFailure,
  CanonicalImplementationRequirements
>;
type AcceptsWidenedFailure = [WidenedImplementation] extends [DeclaredImplementation]
  ? true
  : false;

it("rejects an implementation whose success channel differs from its canonical declaration", () => {
  expectTypeOf<AcceptsWrongSuccess>().toEqualTypeOf<false>();
});

it("rejects an implementation whose failure channel exceeds its canonical declaration", () => {
  expectTypeOf<AcceptsWidenedFailure>().toEqualTypeOf<false>();
});
