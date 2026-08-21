import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { TranscriptText } from "~/core/transcript/model";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import { ConversationContinuity } from "~/shell/transcript/conversation-continuity";
import { makeWorkingContext } from "./working-context";

const WorkingContextHarness = ConversationContinuity.layer.pipe(Layer.provideMerge(ApiHarness));

const verifyWorkingContext = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const hostedAgentSessionId = yield* continuity.admitSession(defaultUserId);
  const prepared = yield* continuity.prepareTurn(defaultUserId, hostedAgentSessionId, {
    text: TranscriptText.make("working-context-marker"),
  });

  const first = yield* makeWorkingContext(prepared.snapshot);
  const second = yield* makeWorkingContext(prepared.snapshot);

  // The snapshot is plain data, so the same preparation projects identically however often the
  // hosted runtime replays it.
  expect(second).toEqual(first);
  expect(DateTime.isUtc(first.startedAt)).toBe(true);
  expect(first.startedAt).toEqual(prepared.snapshot.startedAt);
  expect(first.hostedAgentSessionId).toBe(hostedAgentSessionId);
});

layer(WorkingContextHarness, { timeout: "30 seconds" })("WorkingContext", (it) => {
  it.effect(
    "projects the same immutable prepared context more than once",
    () => verifyWorkingContext
  );
});
