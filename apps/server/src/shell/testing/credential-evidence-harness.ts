import { inspect } from "node:util";
import { expect } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";

export const exitFailure = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<E> =>
  Exit.isFailure(exit)
    ? Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => Effect.die("expected the effect to fail with an error"),
        onSome: Effect.succeed,
      })
    : Effect.die("expected the effect to fail");

export const renderedFailure = (failure: unknown): Effect.Effect<string, Schema.SchemaError> =>
  Effect.map(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(failure), (serialized) =>
    [String(failure), inspect(failure), serialized].join("\n")
  );

export const expectNotInspected = (value: unknown, ...secrets: ReadonlyArray<string>): void => {
  const inspected = inspect(value);

  for (const secret of secrets) expect(inspected).not.toContain(secret);
};
