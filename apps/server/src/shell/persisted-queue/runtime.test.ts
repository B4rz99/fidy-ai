import { expect, it, layer } from "@effect/vitest";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { declarePersistedQueue } from "./operations";
import { VolatilePersistedQueue } from "./runtime";

const RuntimePayload = Schema.Struct({ value: Schema.String });
const RuntimeQueue = declarePersistedQueue({
  name: "runtime-authority-test",
  schema: RuntimePayload,
  descriptor: {
    component: "whatsapp",
    operation: "whatsapp.processWork",
  },
});

layer(VolatilePersistedQueue)("volatile persisted queue runtime", (it) => {
  it.effect("provides declared queue requirements with volatile storage", () =>
    Effect.gen(function* () {
      const handled = yield* Ref.make("");
      yield* RuntimeQueue.offer({ value: "accepted" }, { id: "runtime-authority-test" });
      yield* RuntimeQueue.handleNext((payload) => Ref.set(handled, payload.value), {
        classify: (failure: never) => failure,
        recordTerminal: () => Effect.void,
      });

      expect(yield* Ref.get(handled)).toBe("accepted");
    })
  );
});

it.effect("publishes queue authority without publishing raw queue storage", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(VolatilePersistedQueue);
    expect(Option.isNone(Context.getOption(services, PersistedQueue.PersistedQueueStore))).toBe(
      true
    );
  })
);
