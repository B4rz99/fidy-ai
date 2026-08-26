import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { CanonicalPreTransactions } from "~/shell/_shared/canonical-pre-transaction";
import { FidyApi } from "~/shell/api";
import { createManualPAT } from "./mutations";
import { approvePATPairing, inspectPATPairing } from "./pat-pairing";

/** Provides fresh authenticated-browser PAT issuance. */
export const PATsLive = HttpApiBuilder.group(FidyApi, "pats", (handlers) =>
  handlers
    .handle("createManualPAT", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* ResolvedCaller;
        return yield* createManualPAT({ userId: caller.subjectUserId, caller, payload });
      })
    )
    .handle("inspectPATPairing", ({ payload }) =>
      CanonicalPreTransactions.preserve(
        Effect.gen(function* () {
          const caller = yield* ResolvedCaller;
          return yield* inspectPATPairing({
            userId: caller.subjectUserId,
            publicCode: payload.publicCode,
          });
        }),
        (caller) =>
          inspectPATPairing({
            userId: caller.subjectUserId,
            publicCode: payload.publicCode,
          })
      )
    )
    .handle("approvePATPairing", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* ResolvedCaller;
        return yield* approvePATPairing({
          userId: caller.subjectUserId,
          caller,
          payload,
        });
      })
    )
);
