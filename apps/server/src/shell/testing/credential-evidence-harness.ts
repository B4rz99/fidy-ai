import { inspect } from "node:util";
import { expect } from "@effect/vitest";
import { Cause, type Context, Effect, Exit, Layer, Option, Schema, type Scope } from "effect";

export const buildLayerExit = <A, E, R>(
  layer: Layer.Layer<A, E, R>
): Effect.Effect<Exit.Exit<Context.Context<A>, E>, never, Exclude<R, Scope.Scope>> =>
  Effect.exit(Effect.scoped(Layer.build(layer)));

export const exitFailure = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<E> =>
  Exit.isFailure(exit)
    ? Effect.succeed(Option.getOrThrow(Cause.findErrorOption(exit.cause)))
    : Effect.die("expected the effect to fail");

export const renderedFailure = (failure: unknown): Effect.Effect<string, Schema.SchemaError> =>
  Effect.map(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(failure), (serialized) =>
    [String(failure), inspect(failure), serialized].join("\n")
  );

export const expectNotInspected = (value: unknown, ...secrets: ReadonlyArray<string>): void => {
  const inspected = inspect(value);
  for (const secret of secrets) expect(inspected).not.toContain(secret);
};
