import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { CanonicalPreTransactions } from "~/shell/_shared/canonical-pre-transaction";
import { FidyApi } from "~/shell/api";
import { createManualPAT, revokeAllPATs, revokePAT } from "./mutations";
import { approvePATPairing, inspectPATPairing } from "./pat-pairing";
import { listPATs } from "./queries";

/** Provides fresh authenticated-browser PAT issuance. */
export const PATsLive = HttpApiBuilder.group(FidyApi, "pats", (handlers) =>
  handlers
    .handle("listPATs", () =>
      Effect.flatMap(ResolvedCaller, (caller) => listPATs({ userId: caller.subjectUserId }))
    )
    .handle("revokePAT", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* ResolvedCaller;
        return yield* revokePAT({
          userId: caller.subjectUserId,
          caller,
          confirmationEvidence: Option.none,
          shortId: params.shortId,
        });
      })
    )
    .handle("revokeAllPATs", () =>
      Effect.gen(function* () {
        const caller = yield* ResolvedCaller;
        return yield* revokeAllPATs({
          userId: caller.subjectUserId,
          caller,
          confirmationEvidence: Option.none,
        });
      })
    )
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
