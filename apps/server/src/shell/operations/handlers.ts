import { DateTime, Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { resolveAccessTierInScope } from "~/shell/_shared/access-tier";
import { CanonicalPreTransactions } from "~/shell/_shared/canonical-pre-transaction";
import { FidyApi } from "~/shell/api";
import { executeAtomicBatch } from "./atomic-batch";

/** Visible canonical batch handler; the authorization middleware owns its User transaction. */
export const OperationsLive = HttpApiBuilder.group(FidyApi, "operations", (handlers) =>
  handlers.handle("executeAtomicBatch", ({ payload }) =>
    CanonicalPreTransactions.preserve(
      Effect.gen(function* () {
        const caller = yield* ResolvedCaller;
        const accessTier = yield* resolveAccessTierInScope(
          caller.subjectUserId,
          yield* DateTime.now
        );
        return yield* executeAtomicBatch({
          payload,
          caller,
          accessTier,
          confirmationEvidence: Option.none,
        });
      }),
      (caller, accessTier) =>
        executeAtomicBatch({ payload, caller, accessTier, confirmationEvidence: Option.none })
    )
  )
);
