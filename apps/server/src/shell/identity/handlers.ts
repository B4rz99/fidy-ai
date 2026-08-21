import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { updateUserPreferences } from "./mutations";
import { getCurrentUser } from "./queries";

/** Stable-User handlers; bearer ownership remains context, never payload. */
export const IdentityLive = HttpApiBuilder.group(FidyApi, "identity", (handlers) =>
  handlers
    .handle("getCurrentUser", () =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* ResolvedCaller;
        return yield* getCurrentUser({ userId });
      })
    )
    .handle("updateUserPreferences", ({ payload }) =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* ResolvedCaller;
        return yield* updateUserPreferences({ userId, payload });
      })
    )
);
