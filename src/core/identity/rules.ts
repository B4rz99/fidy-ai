import { DateTime, Effect, Struct } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { type UserId } from "./reference";
import { type EffectiveAccess, User } from "./model";

const ColombianUserInput = User.mapFields(Struct.pick(["createdAt", "paidTier"]));
const AccessDecisionInput = User.mapFields(Struct.pick(["paidTier", "trialPeriod"]));

/**
 * Creates the stable User record for a new Colombian User. The caller supplies
 * identity, time, and paid tier from the shell; this decision supplies each
 * context value explicitly and starts the User's single 168-hour TrialPeriod.
 */
export const makeColombianUser = Effect.fn("makeColombianUser")(function* (
  userId: UserId,
  input: typeof ColombianUserInput.Type
) {
  return yield* Effect.succeed(
    User.make({
      id: userId,
      serviceMarket: ServiceMarket.make("CO"),
      locale: Locale.make("es-CO"),
      timeZone: IanaTimeZone.make("America/Bogota"),
      paidTier: input.paidTier,
      trialPeriod: {
        startedAt: input.createdAt,
        endsAt: DateTime.addDuration(input.createdAt, "168 hours"),
      },
      createdAt: input.createdAt,
    })
  );
});

/**
 * Derives the User's access at one caller-supplied UTC instant. TrialPeriod is
 * half-open: its start is included and its end is Free unless paid tier is Pro.
 */
export const decideEffectiveAccess = Effect.fn("decideEffectiveAccess")(function* (
  access: typeof AccessDecisionInput.Type,
  now: DateTime.Utc
) {
  const trialActive =
    DateTime.Order(access.trialPeriod.startedAt, now) <= 0 &&
    DateTime.Order(now, access.trialPeriod.endsAt) < 0;
  return yield* Effect.succeed<EffectiveAccess>(
    access.paidTier === "pro" || trialActive ? "pro" : "free"
  );
});
