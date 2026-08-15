import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { TranscriptText } from "~/core/transcript/model";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import {
  ConversationContinuity,
  type PreparedAttempt,
} from "~/shell/transcript/conversation-continuity";
import { makeWorkingContext } from "./working-context";

const WorkingContextHarness = ConversationContinuity.layer.pipe(Layer.provideMerge(ApiHarness));

const verifyPreparedContext = Effect.fn("WorkingContextTest.verifyPreparedContext")(function* (
  prepared: PreparedAttempt
) {
  const first = yield* makeWorkingContext(prepared.context);
  const second = yield* makeWorkingContext(prepared.context);

  expect(second).toEqual(first);
  expect(DateTime.isUtc(first.startedAt)).toBe(true);
  expect(first.startedAt).toEqual(prepared.context.startedAt);
  return prepared.context;
});

const verifyWorkingContext = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const releasedContext = yield* continuity.withSerializedAttempt(
    defaultUserId,
    { text: TranscriptText.make("working-context-marker") },
    (attempt) => attempt.prepare(verifyPreparedContext)
  );
  const failure = yield* Effect.flip(makeWorkingContext(releasedContext));
  expect(failure.reason).toBe("InvalidAuthority");
});

layer(WorkingContextHarness, { timeout: "30 seconds" })("WorkingContext", (it) => {
  it.effect(
    "projects the same immutable prepared context more than once",
    () => verifyWorkingContext
  );
});
