import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { UserId } from "~/core/identity/contract";

import type { OwnedStatement } from "~/shell/owner-write/contract";
import { Unavailable } from "~/shell/public-http/contract";
import { protectConsentAuthority } from "~/shell/consent/operations";
import type { WebSessionAuthority, WebSessionSubject } from "~/shell/web-session/contract";
import { webSessionCredentialAuthority } from "~/shell/web-session/operations";
import { currentUserQuery, decodeUser } from "~/shell/identity/internal/user-query";
import type { CurrentUserResponse, PreparedCurrentUserRead } from "./contract";

const userUnavailable = (): Unavailable =>
  Unavailable.make({
    error: { code: "unavailable", message: "User data is temporarily unavailable. Retry later." },
    next: [],
  });

/**
 * Prepare the complete canonical projection for one authenticated User. The statement observes
 * that User's current Consent grant at execution; preparation confers no credential authority.
 */
export const prepareCurrentUser = (
  userId: UserId
): Effect.Effect<PreparedCurrentUserRead, Unavailable> =>
  Schema.decodeEffect(UserId)(userId).pipe(
    Effect.map((subject) => ({
      statement: currentUserQuery(subject),
      decode: (rows: ReadonlyArray<unknown>) =>
        decodeUser(rows[0]).pipe(
          Effect.flatMap((data) =>
            data.id === subject
              ? Effect.succeed({ data, next: [] as const })
              : Effect.fail(userUnavailable())
          ),
          Effect.mapError(userUnavailable)
        ),
    })),
    Effect.mapError(userUnavailable)
  );

/**
 * Load the resolved stable User while rechecking Consent in the authoritative read.
 * Missing, inaccessible, or invalid state returns the same safe unavailable response.
 */
export const getCurrentUser = (
  userId: UserId
): Effect.Effect<CurrentUserResponse, Unavailable, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = yield* prepareCurrentUser(userId);
    const rows = yield* sql.unsafe(read.statement.sql, read.statement.params);
    return yield* read.decode(rows);
  }).pipe(Effect.mapError(userUnavailable));

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
