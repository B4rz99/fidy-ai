import { Data, Effect } from "effect";
import type { SmokeFailureStage } from "../contract";

export class SmokeBindingFailed extends Data.TaggedError("SmokeBindingFailed")<{
  stage: SmokeFailureStage;
}> {}

export const platform = <A>({
  tryWork,
  stage,
}: Readonly<{ tryWork: () => Promise<A>; stage: SmokeFailureStage }>): Effect.Effect<
  A,
  SmokeBindingFailed
> =>
  Effect.tryPromise({
    try: tryWork,
    catch: () => new SmokeBindingFailed({ stage }),
  });
