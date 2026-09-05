import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { UserId } from "~/core/identity/reference";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { ForwardedEmailWorkflowPayload } from "./forwarded-email-workflow";

it.effect("decodes a revisionless forwarded-email workflow payload as revision one", () =>
  Effect.gen(function* () {
    const payload = yield* Schema.decodeEffect(ForwardedEmailWorkflowPayload)({
      userId: "f1d1a000-0000-4000-8000-000000000101",
      receivedEmailId: "received-workflow-evolution",
    });
    expect(payload).toEqual({
      userId: UserId.make("f1d1a000-0000-4000-8000-000000000101"),
      receivedEmailId: ResendReceivedEmailId.make("received-workflow-evolution"),
      revision: 1,
    });
  })
);
