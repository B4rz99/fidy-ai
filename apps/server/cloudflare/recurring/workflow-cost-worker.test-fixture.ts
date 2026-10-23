import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";

export { default as handler } from "../coordinator-test-harness";
export { UserTransactionCoordinator } from "../transactions/runtime";

const Payload = Schema.Struct({
  version: Schema.Literal(1),
  userId: UserId,
  revision: Schema.Int,
  steps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
});
type Environment = Readonly<{ USER_TRANSACTION_COORDINATOR: DurableObjectNamespace }>;
const coordinate = (
  input: Readonly<{ environment: Environment; userId: UserId; body: string; index: number }>
): Promise<number> =>
  input.environment.USER_TRANSACTION_COORDINATOR.getByName(input.userId)
    .fetch("https://coordinator/recurring-work", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: input.body,
    })
    .then((response) => {
      if (!response.ok) throw Error("Recurring coordinator refused cost experiment");
      return input.index;
    });
/** Experimental overhead floor, not a second production detector or a cursor cutover. */
export class DetectionCostWorkflow extends WorkflowEntrypoint<Environment, typeof Payload.Type> {
  run(event: WorkflowEvent<typeof Payload.Type>, step: WorkflowStep): Promise<number> {
    const environment = this.env;
    return Effect.runPromise(
      Effect.gen(function* () {
        const payload = yield* Schema.decodeEffect(Payload)(event.payload);
        const body = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Struct({ userId: UserId }))
        )({ userId: payload.userId });
        for (let index = 0; index < payload.steps; index++) {
          yield* Effect.tryPromise(() =>
            step.do(`v1-evaluate-${index}`, { retries: { limit: 0, delay: "1 second" } }, () =>
              coordinate({ environment, userId: payload.userId, body, index })
            )
          );
        }
        return payload.steps;
      })
    );
  }
}
