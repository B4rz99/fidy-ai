import { expect, it, layer } from "@effect/vitest";
import { Effect, Fiber, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { DurableExecutionMemory } from "~/shell/durable-execution";
import { EmailDeliveryIntentId } from "~/core/email-authentication/model";
import {
  OnboardingDeliveryPayload,
  OnboardingEmailDeliveryWorkflow,
  onboardingEmailDeliveryQueue,
} from "./delivery-workflow";

const intentId = EmailDeliveryIntentId.make("019cda32-1250-7000-8000-000000000460");
const increment = (value: number): number => value + 1;
const recordDelivery = (deliveries: Ref.Ref<number>): Effect.Effect<void> =>
  Ref.update(deliveries, increment);

it.effect("decodes the original onboarding delivery payload after its schema evolves", () =>
  Effect.gen(function* () {
    const payload = yield* Schema.decodeEffect(OnboardingDeliveryPayload)({ intentId });

    expect(payload).toEqual({ intentId, revision: 1 });
  })
);

it.effect("derives one workflow execution from the stable delivery intent identity", () =>
  Effect.gen(function* () {
    const first = yield* OnboardingEmailDeliveryWorkflow.executionId({ intentId, revision: 1 });
    const duplicate = yield* OnboardingEmailDeliveryWorkflow.executionId({
      intentId,
      revision: 1,
    });

    expect(duplicate).toBe(first);
  })
);

it.effect("keeps the runtime-decoded persisted payload identifier-only and bounded", () =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(OnboardingDeliveryPayload))({
      intentId,
      revision: 1,
    });
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(OnboardingDeliveryPayload))({
      intentId,
      revision: 1,
    });

    expect(encoded).toEqual({ intentId, revision: 1 });
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(128);
  })
);

layer(DurableExecutionMemory)("native onboarding delivery queue", (it) => {
  it.effect("converges duplicate publication identities on one native queue item", () =>
    Effect.gen(function* () {
      const queue = yield* onboardingEmailDeliveryQueue;
      yield* queue.offer({ intentId, revision: 1 }, { id: intentId });
      yield* queue.offer({ intentId, revision: 1 }, { id: intentId });

      const deliveries = yield* Ref.make(0);
      yield* queue.take(() => recordDelivery(deliveries));
      const duplicateFiber = yield* queue
        .take(() => recordDelivery(deliveries))
        .pipe(Effect.timeoutOption("10 millis"), Effect.forkChild);
      yield* TestClock.adjust("20 millis");
      const duplicate = yield* Fiber.join(duplicateFiber);

      expect(yield* Ref.get(deliveries)).toBe(1);
      expect(Option.isNone(duplicate)).toBe(true);
    })
  );
});
