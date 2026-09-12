import { expect } from "@effect/vitest";
import { Cause, type Context, Effect, Exit, Layer, Option, Schema, type Scope } from "effect";

/**
 * Builds a layer into an Exit so a failure-path test can inspect the typed construction failure
 * instead of a thrown defect, without repeating the scoped-build wrapper.
 */
export const buildLayerExit = <A, E, R>(
  layer: Layer.Layer<A, E, R>
): Effect.Effect<Exit.Exit<Context.Context<A>, E>, never, Exclude<R, Scope.Scope>> =>
  Effect.exit(Effect.scoped(Layer.build(layer)));

/**
 * Extracts the first typed failure from an Exit that must have failed. It dies when the effect
 * unexpectedly succeeded, so a credential-evidence test can never pass by not exercising its path.
 */
export const exitFailure = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<E> =>
  Exit.isFailure(exit)
    ? Effect.succeed(Option.getOrThrow(Cause.findErrorOption(exit.cause)))
    : Effect.die("expected the effect to fail");

/**
 * Renders a typed failure the way an operator or telemetry pipeline would, so evidence assertions
 * can prove a credential never reaches a message, an inspector, or a serialized error.
 */
export const renderedFailure = (failure: unknown): Effect.Effect<string, Schema.SchemaError> =>
  Effect.map(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(failure), (serialized) =>
    [String(failure), Bun.inspect(failure), serialized].join("\n")
  );

/**
 * Proves that inspecting a service, a wrapped Secret, or a failure never renders any of the given
 * Secrets, so credential evidence covers service inspection as well as serialized failures.
 */
export const expectNotInspected = (value: unknown, ...secrets: ReadonlyArray<string>): void => {
  const inspected = Bun.inspect(value);
  for (const secret of secrets) expect(inspected).not.toContain(secret);
};
