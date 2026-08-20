import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { detectRecurringSeries } from "./mutations";
import { reportRecurringSeries } from "./repo";

/** Serves the caller's Currency-grouped RecurringSeries and the detection pass that records them. */
export const RecurringLive = HttpApiBuilder.group(FidyApi, "recurring", (handlers) =>
  handlers
    .handle("listRecurringSeries", () =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return { data: yield* reportRecurringSeries(subjectUserId), next: [] };
      })
    )
    .handle("detectRecurringSeries", () =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return yield* detectRecurringSeries({ userId: subjectUserId });
      })
    )
);
