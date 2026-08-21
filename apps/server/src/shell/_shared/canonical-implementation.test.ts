import { it } from "@effect/vitest";
import { type Effect } from "effect";
import { expectTypeOf } from "vitest";
import type {
  CanonicalImplementationRequirements,
  CanonicalOperationImplementations,
} from "./canonical-implementation";

type DeclaredImplementation = CanonicalOperationImplementations["transactions.getTransaction"];
type UndeclaredFailure = Readonly<{ readonly _tag: "UndeclaredFailure" }>;
type WidenedImplementation = (
  input: Parameters<DeclaredImplementation>[0],
  caller: Parameters<DeclaredImplementation>[1]
) => Effect.Effect<
  unknown,
  Effect.Error<ReturnType<DeclaredImplementation>> | UndeclaredFailure,
  CanonicalImplementationRequirements
>;
type AcceptsWidenedFailure = [WidenedImplementation] extends [DeclaredImplementation]
  ? true
  : false;

it("rejects an implementation whose failure channel exceeds its canonical declaration", () => {
  expectTypeOf<AcceptsWidenedFailure>().toEqualTypeOf<false>();
});
