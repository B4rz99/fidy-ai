import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { TranscriptText } from "~/core/transcript/model";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import {
  ConversationContinuity,
  type PreparedAttempt,
} from "~/shell/transcript/conversation-continuity";
import { claimWorkingContext, makeWorkingContext } from "./working-context";

const WorkingContextHarness = ConversationContinuity.layer.pipe(Layer.provideMerge(ApiHarness));

const verifyPreparedAuthority = Effect.fn("WorkingContextTest.verifyPreparedAuthority")(function* (
  prepared: PreparedAttempt
) {
  const context = yield* makeWorkingContext(prepared.context);
  expect(claimWorkingContext(context)._tag).toBe("Some");
  expect(claimWorkingContext(context)._tag).toBe("None");
  expect(Exit.isFailure(yield* Effect.exit(makeWorkingContext(prepared.context)))).toBe(true);
  expect(claimWorkingContext({ startedAt: context.startedAt })._tag).toBe("None");
});

const verifyWorkingContextAuthority = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* continuity.withSerializedAttempt(
    defaultUserId,
    { text: TranscriptText.make("working-context-marker") },
    (attempt) => attempt.prepare(verifyPreparedAuthority)
  );
});

layer(WorkingContextHarness, { timeout: "30 seconds" })("WorkingContext authorities", (it) => {
  it.effect(
    "consumes PreparedAttempt.context once and rejects a second projection claim",
    () => verifyWorkingContextAuthority
  );
});
