import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";
import { readRecurringDigestSource } from "./operations";
import originalHandler from "../coordinator-test-harness";

export { UserTransactionCoordinator } from "../transactions/runtime";
const Input = Schema.Struct({ userId: UserId, cursor: Schema.NullOr(Schema.String) });
const Metadata = Schema.Struct({
  cursor: Schema.NullOr(Schema.String),
  complete: Schema.Boolean,
  total: Schema.Int,
  count: Schema.Int,
});
const Payload = Schema.Struct({ version: Schema.Literal(1), userId: UserId });
type Environment = Readonly<{ DB: D1Database }>;
const page = Effect.fn(function* (environment: Environment, input: typeof Input.Type) {
  const source = yield* readRecurringDigestSource({
    db: environment.DB,
    userId: input.userId,
    cursor: Option.fromNullishOr(input.cursor),
  });
  return Metadata.make({
    cursor: Option.getOrNull(source.cursor),
    complete: source.complete,
    total: source.total,
    count: source.confirmations.length,
  });
});
export const handler = {
  fetch: (request: Request, environment: Environment): Promise<Response> => {
    if (new URL(request.url).pathname !== "/digest-cost-source") {
      return originalHandler.fetch(request, environment);
    }
    return Effect.runPromise(
      Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(Input)(
          yield* Effect.tryPromise(() => request.json())
        );
        return Response.json(yield* page(environment, input));
      })
    );
  },
};
/** Optimistic engine-overhead floor only: no staging, launch recovery, generation claim or publication. */
export class DigestSourceCostWorkflow extends WorkflowEntrypoint<Environment, typeof Payload.Type> {
  run(event: WorkflowEvent<typeof Payload.Type>, step: WorkflowStep): Promise<number> {
    const environment = this.env;
    return Effect.runPromise(
      Effect.gen(function* () {
        const input = yield* Schema.decodeEffect(Payload)(event.payload);
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        let position = Input.make({ userId: input.userId, cursor: null });
        let count = 0;
        for (let index = 0; index < 4; index++) {
          const source = yield* Effect.tryPromise(() =>
            step.do(`v1-source-page-${index}`, { retries: { limit: 0, delay: "1 second" } }, () =>
              run(page(environment, position))
            )
          );
          count += source.count;
          if (source.complete) return count;
          position = { ...position, cursor: source.cursor };
        }
        return yield* Effect.die("Digest experiment exceeded the existing 128-item bound");
      })
    );
  }
}
