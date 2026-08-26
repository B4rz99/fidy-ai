import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { requestEmailReplacement } from "./replacement-mutations";

/** Implements the canonical authenticated operation that requests email replacement. */
export const EmailAuthenticationLive = HttpApiBuilder.group(
  FidyApi,
  "emailAuthentication",
  (handlers) =>
    handlers.handle("requestEmailReplacement", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* ResolvedCaller;
        return yield* requestEmailReplacement({ userId: caller.subjectUserId, payload });
      })
    )
);
