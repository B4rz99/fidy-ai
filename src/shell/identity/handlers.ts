import { Effect } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { UserId } from "~/core/identity/reference";
import { resolveCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { findUser, updateUserPreferences } from "./repo";

const authenticatedUserMissing = (userId: UserId) => (): Error =>
  new Error(`Authenticated User ${userId} is missing`);

/** Stable-User handlers; bearer ownership remains context, never payload. */
export const IdentityLive = HttpApiBuilder.group(FidyApi, "identity", (handlers) =>
  handlers
    .handle("getCurrentUser", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { subjectUserId: userId } = yield* resolveCaller(request);
        const user = yield* findUser(userId).pipe(
          Effect.flatMap(Effect.fromOption(authenticatedUserMissing(userId))),
          Effect.orDie
        );

        return { data: user, next: [] };
      })
    )
    .handle("updateUserPreferences", ({ payload }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { subjectUserId: userId } = yield* resolveCaller(request);
        const user = yield* updateUserPreferences(userId, payload).pipe(
          Effect.flatMap(Effect.fromOption(authenticatedUserMissing(userId))),
          Effect.orDie
        );

        return { data: user, next: [] };
      })
    )
);
