import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { UserId } from "~/core/identity/reference";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { findUser, updateUserPreferences } from "./repo";

const authenticatedUserMissing = (userId: UserId) => (): Error =>
  new Error(`Authenticated User ${userId} is missing`);

/** Stable-User handlers; bearer ownership remains context, never payload. */
export const IdentityLive = HttpApiBuilder.group(FidyApi, "identity", (handlers) =>
  handlers
    .handle("getCurrentUser", () =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* ResolvedCaller;
        const user = yield* findUser(userId).pipe(
          Effect.flatMap(Effect.fromOption(authenticatedUserMissing(userId))),
          Effect.orDie
        );

        return { data: user, next: [] };
      })
    )
    .handle("updateUserPreferences", ({ payload }) =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* ResolvedCaller;
        const user = yield* updateUserPreferences(userId, payload).pipe(
          Effect.flatMap(Effect.fromOption(authenticatedUserMissing(userId))),
          Effect.orDie
        );

        return { data: user, next: [] };
      })
    )
);
