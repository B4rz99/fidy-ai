import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";

export const processFree = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("unexpected process"))
);
