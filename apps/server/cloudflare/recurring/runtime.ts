import { Effect, Schema } from "effect";
import type { UserId } from "../../src/core/identity/contract";
import { discoverRecurringWork } from "./operations";
import { RecurringUnavailable, RecurringWork } from "./contract";

type Coordinator = Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
const advanceUser = ({
  coordinator,
  userId,
}: Readonly<{ coordinator: Coordinator; userId: UserId }>): Effect.Effect<
  void,
  RecurringUnavailable
> =>
  Effect.gen(function* () {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(RecurringWork))({ userId });
    return yield* Effect.tryPromise({
      try: (signal) =>
        coordinator.getByName(userId).fetch("https://coordinator/recurring-work", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal,
        }),
      catch: () => new RecurringUnavailable(),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok ? Effect.void : Effect.fail(new RecurringUnavailable())
      ),
      Effect.timeout("5 seconds")
    );
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));

/** Advance four User identities through the existing coordinator; durable D1 progress survives every tick. */
export const advanceRecurringWork = ({
  DB,
  USER_TRANSACTION_COORDINATOR,
}: Readonly<{ DB: D1Database; USER_TRANSACTION_COORDINATOR: Coordinator }>): Effect.Effect<
  void,
  RecurringUnavailable
> =>
  Effect.gen(function* () {
    const users = yield* discoverRecurringWork(DB);
    const results = yield* Effect.forEach(
      users,
      (userId) => Effect.exit(advanceUser({ coordinator: USER_TRANSACTION_COORDINATOR, userId })),
      { concurrency: 1 }
    );
    if (results.some((result) => result._tag === "Failure")) {
      return yield* new RecurringUnavailable();
    }
  }).pipe(Effect.withSpan("recurring.evaluate"));
