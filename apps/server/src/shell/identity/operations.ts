import { Effect, Option } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { User } from "~/core/identity/contract";
import type { UserId } from "~/core/identity/reference";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { Unavailable } from "~/shell/public-http/contract";
import { protectConsentAuthority } from "~/shell/consent/operations";
import type { WebSessionAuthority, WebSessionSubject } from "~/shell/web-session/contract";
import { webSessionCredentialAuthority } from "~/shell/web-session/operations";
import { findUser } from "~/shell/identity/internal/user-query";

const userUnavailable = (): Unavailable =>
  Unavailable.make({
    error: { code: "unavailable", message: "User data is temporarily unavailable. Retry later." },
    next: [],
  });

/**
 * Load the resolved stable User while rechecking Consent in the authoritative read.
 * Missing, inaccessible, or invalid state returns the same safe unavailable response.
 */
export const getCurrentUser = (
  userId: UserId
): Effect.Effect<
  { readonly data: User; readonly next: ReadonlyArray<never> },
  Unavailable,
  SqlClient.SqlClient
> =>
  findUser(userId).pipe(
    Effect.flatMap((user) =>
      Option.match(user, {
        onNone: () => Effect.fail(userUnavailable()),
        onSome: (data) => Effect.succeed({ data, next: [] as const }),
      })
    ),
    Effect.mapError(userUnavailable)
  );

/** D1 predicate that is re-evaluated with a protected browser canonical read. */
export const liveWebSessionAuthority = (
  input: Readonly<{ subject: WebSessionSubject; current: number }>
): WebSessionAuthority => {
  const credential = webSessionCredentialAuthority(input);
  return protectConsentAuthority({
    authority: credential,
    subject: { _tag: "Owner", column: "web_sessions.user_id" },
    requirement: "unrevoked",
  });
};

/**
 * Select one User's original TrialPeriod for composition inside a caller-owned statement.
 * The bounded projection exposes startedAtMs and endsAtMs as UTC epoch milliseconds;
 * absent state produces no row. The caller retains responsibility for its access authority.
 */
export const userTrialPeriodQuery = (userId: UserId): OwnedStatement => ({
  sql: `SELECT started_at_ms AS startedAtMs, ends_at_ms AS endsAtMs
    FROM trial_periods WHERE user_id = ? LIMIT 1`,
  params: [userId],
});

/**
 * Recheck the original TrialPeriod's half-open interval inside the caller's protected work.
 * Missing or out-of-window state is false; another User's trial never affects this condition.
 */
export const activeTrialPeriodCondition = ({
  userId,
  nowEpochMs,
}: Readonly<{ userId: UserId; nowEpochMs: number }>): OwnedStatement => {
  const trial = userTrialPeriodQuery(userId);
  return {
    sql: `EXISTS (SELECT 1 FROM (${trial.sql}) AS trial
      WHERE trial.startedAtMs <= ? AND trial.endsAtMs > ?)`,
    params: [...trial.params, nowEpochMs, nowEpochMs],
  };
};
