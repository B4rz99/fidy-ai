import { DateTime, Effect } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { type UserId } from "./reference";
import { type TrialPeriod, User } from "./model";

/** Whether the caller-supplied instant falls inside the immutable half-open TrialPeriod. */
export const isTrialPeriodActive = Effect.fn("isTrialPeriodActive")(function* (
  trialPeriod: TrialPeriod,
  now: DateTime.Utc
) {
  return yield* Effect.succeed(
    DateTime.Order(trialPeriod.startedAt, now) <= 0 && DateTime.Order(now, trialPeriod.endsAt) < 0
  );
});

/** Creates a Colombian User and its one immutable 168-hour TrialPeriod at createdAt. */
export const makeColombianUser = Effect.fn(function* (
  userId: UserId,
  input: Pick<User, "createdAt">
) {
  return yield* Effect.succeed(
    User.make({
      id: userId,
      serviceMarket: ServiceMarket.make("CO"),
      locale: Locale.make("es-CO"),
      timeZone: IanaTimeZone.make("America/Bogota"),
      trialPeriod: {
        startedAt: input.createdAt,
        endsAt: DateTime.addDuration(input.createdAt, "168 hours"),
      },
      createdAt: input.createdAt,
    })
  );
});
