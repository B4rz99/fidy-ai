import { type DateTime, Effect } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { type UserId } from "~/core/_shared/user";
import { User } from "./model";

type ColombianUserInput = Readonly<{ readonly createdAt: DateTime.Utc }>;

/**
 * Creates the stable User record for a new Colombian User. The caller supplies
 * identity and time from the shell; this decision supplies each context value
 * explicitly and performs no inference between them.
 */
export const makeColombianUser = Effect.fn("makeColombianUser")(function* (
  userId: UserId,
  input: ColombianUserInput
) {
  return yield* Effect.succeed(
    User.make({
      id: userId,
      serviceMarket: ServiceMarket.make("CO"),
      locale: Locale.make("es-CO"),
      timeZone: IanaTimeZone.make("America/Bogota"),
      createdAt: input.createdAt,
    })
  );
});
