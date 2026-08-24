import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { createManualPAT } from "./mutations";

/** Provides fresh authenticated-browser PAT issuance. */
export const PATsLive = HttpApiBuilder.group(FidyApi, "pats", (handlers) =>
  handlers.handle("createManualPAT", ({ payload }) =>
    Effect.gen(function* () {
      const caller = yield* ResolvedCaller;
      return yield* createManualPAT({ userId: caller.subjectUserId, caller, payload });
    })
  )
);
