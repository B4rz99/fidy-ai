import { Effect } from "effect";
import type { UserId } from "~/core/identity/reference";
import { findUser } from "./repo";

const authenticatedUserMissing = (userId: UserId) => (): Error =>
  new Error(`Authenticated User ${userId} is missing`);

/**
 * Reads the authorized User's own record. An absent row is a defect rather than a not-found
 * response, because authorization already resolved this User.
 */
export const getCurrentUser = Effect.fn("getCurrentUser")(function* ({
  userId,
}: Readonly<{ userId: UserId }>) {
  const data = yield* findUser(userId).pipe(
    Effect.flatMap(Effect.fromOption(authenticatedUserMissing(userId))),
    Effect.orDie
  );
  return { data, next: [] };
});
