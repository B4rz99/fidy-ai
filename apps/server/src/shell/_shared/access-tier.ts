import { type DateTime, Effect } from "effect";
import { decideAccessTier } from "~/core/_shared/access-tier";
import { isTrialPeriodActive } from "~/core/identity/rules";
import type { UserId } from "~/core/identity/reference";
import { findUserInScope } from "~/shell/identity/repo";
import { hasPaidProInScope } from "~/shell/subscription/access-repo";

/** Resolves current capabilities inside the caller's existing User-scoped transaction. */
export const resolveAccessTierInScope = Effect.fn("resolveAccessTierInScope")(function* (
  userId: UserId,
  now: DateTime.Utc
) {
  const user = yield* findUserInScope(userId).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);
  const paidProActive = yield* hasPaidProInScope(userId);
  const trialActive = yield* isTrialPeriodActive(user.trialPeriod, now);
  return yield* decideAccessTier({ trialActive, paidProActive });
});
