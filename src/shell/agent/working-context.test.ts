import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Schema } from "effect";
import { TranscriptText } from "~/core/transcript/model";
import { TranscriptWindowCharacterLimit, TranscriptWindowTurnLimit } from "~/core/transcript/rules";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import {
  ConversationContinuity,
  type PreparedAttempt,
} from "~/shell/transcript/conversation-continuity";
import { claimWorkingContextProjection, makeWorkingContext } from "./working-context";

const WorkingContextHarness = ConversationContinuity.layer.pipe(Layer.provideMerge(ApiHarness));
const limits = {
  maxTranscriptTurns: TranscriptWindowTurnLimit.make(12),
  maxTranscriptCharacters: TranscriptWindowCharacterLimit.make(32_000),
  maxToolResultCharacters: 16_000,
};

const ForgedWorkingContext = Schema.declare(
  (input): input is Parameters<typeof claimWorkingContextProjection>[0] =>
    typeof input === "object" && input !== null
);

const verifyPreparedAuthority = Effect.fn("WorkingContextTest.verifyPreparedAuthority")(function* (
  prepared: PreparedAttempt
) {
  const context = yield* makeWorkingContext(prepared.context, limits);
  expect(Option.isSome(claimWorkingContextProjection(context))).toBe(true);
  expect(Option.isNone(claimWorkingContextProjection(context))).toBe(true);
  expect(Exit.isFailure(yield* Effect.exit(makeWorkingContext(prepared.context, limits)))).toBe(
    true
  );
  const forged = yield* Schema.decodeUnknownEffect(ForgedWorkingContext)({});
  expect(Option.isNone(claimWorkingContextProjection(forged))).toBe(true);
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
