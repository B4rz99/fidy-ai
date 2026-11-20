import { DateTime, Effect } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { type TrialPeriod, User, type UserId } from "./contract";

export const isTrialPeriodActive = Effect.fn("isTrialPeriodActive")(function* (
  trialPeriod: TrialPeriod,
  now: DateTime.Utc
) {
  return yield* Effect.succeed(
    DateTime.Order(trialPeriod.startedAt, now) <= 0 && DateTime.Order(now, trialPeriod.endsAt) < 0
  );
});

export const makeColombianUser = ({
  userId,
  createdAt,
}: Readonly<{ userId: UserId }> & Pick<User, "createdAt">): User =>
  User.make({
    id: userId,
    serviceMarket: ServiceMarket.make("CO"),
    locale: Locale.make("es-CO"),
    timeZone: IanaTimeZone.make("America/Bogota"),
    trialPeriod: {
      startedAt: createdAt,
      endsAt: DateTime.addDuration(createdAt, "168 hours"),
    },
    createdAt,
  });
