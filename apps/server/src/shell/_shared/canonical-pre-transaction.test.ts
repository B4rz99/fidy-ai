import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { takeCanonicalPreTransactionState } from "./canonical-pre-transaction";

it.effect("has no prepared state outside a canonical adapter", () =>
  Effect.gen(function* () {
    expect(Option.isNone(yield* takeCanonicalPreTransactionState)).toBe(true);
  })
);
