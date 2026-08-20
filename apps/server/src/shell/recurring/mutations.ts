import { DateTime, Effect, type Schema } from "effect";
import type { UserId } from "~/core/identity/reference";
import { Money, MoneyGroup } from "~/core/_shared/money";
import type { RecurringDetectionOutcome } from "~/core/recurring/model";
import {
  detectRecurringSeries as confirmSeries,
  summarizeConfirmedSeries,
} from "~/core/recurring/rules";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import type { OperationResponse } from "~/shell/_shared/response";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { findUserInScope } from "~/shell/identity/repo";
import {
  deleteUnconfirmedSeriesInScope,
  listRecurringCandidatesInScope,
  upsertRecurringSeriesInScope,
} from "./repo";

type MutationResponse<Data extends Schema.Top> = ReturnType<typeof OperationResponse<Data>>["Type"];

export type DetectRecurringSeriesInput = Readonly<{ userId: UserId }>;

/**
 * Re-examines one User's whole Transaction history, records every repeating charge the detector
 * confirms, and forgets the recorded series it no longer confirms. Answers only the series that
 * were not already recorded — the newly confirmed ones behind the `new recurring series
 * confirmed` trigger — so a repeated pass over unchanged history answers nothing.
 *
 * The User's own creation instant is what separates imported history from movements fidy watched
 * as they happened, and it decides the suppression each recorded series carries.
 */
export const detectRecurringSeries: CanonicalMutationImplementation<
  DetectRecurringSeriesInput,
  MutationResponse<typeof RecurringDetectionOutcome>,
  never
> = Effect.fn("detectRecurringSeries")(function* ({ userId }) {
  const now = yield* DateTime.now;
  const confirmed = yield* withUserLockInScope(
    advisoryLockKey.recurringSeries(userId),
    Effect.gen(function* () {
      const user = yield* findUserInScope(userId).pipe(
        Effect.flatMap(Effect.fromOption),
        Effect.orDie
      );
      const detected = confirmSeries({
        transactions: yield* listRecurringCandidatesInScope(userId),
        now,
        observedSince: user.createdAt,
      });
      const recorded = yield* Effect.forEach(detected, (series) =>
        upsertRecurringSeriesInScope(userId, series)
      );
      yield* deleteUnconfirmedSeriesInScope(
        userId,
        recorded.map((outcome) => outcome.series)
      );
      return recorded;
    })
  );

  const newlyConfirmed = confirmed
    .filter((outcome) => outcome.confirmedFirstTime)
    .map((outcome) => outcome.series);
  const announcement = yield* summarizeConfirmedSeries(newlyConfirmed);

  return {
    data: {
      confirmed: newlyConfirmed,
      announcement: announcement.map((group) =>
        MoneyGroup.make({
          currency: group.currency,
          inflow: Money.make(group.inflow),
          outflow: Money.make(group.outflow),
        })
      ),
    },
    next: [],
  };
});
