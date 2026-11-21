import { ConsentSubject } from "~/shell/consent/contract";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { UserId, type WhatsAppCallerReference } from "~/core/identity/contract";

import type { OwnedStatement } from "~/shell/owner-write/contract";
import { Unavailable } from "~/shell/public-http/contract";
import { protectConsentAuthority } from "~/shell/consent/operations";
import type { WebSessionAuthority, WebSessionSubject } from "~/shell/web-session/contract";
import { webSessionCredentialAuthority } from "~/shell/web-session/operations";
import {
  currentUserQuery,
  decodeUser,
  selectedCurrentUserQuery,
} from "~/shell/identity/internal/user-query";
import type { CurrentUserResponse, PreparedCurrentUserRead } from "./contract";

export const whatsAppAssociationQuery = ({
  userId,
  caller,
}: Readonly<{ userId: UserId; caller: WhatsAppCallerReference }>): OwnedStatement => ({
  sql: "SELECT user_id AS userId FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) WHERE user_id = ? AND portfolio_id = ? AND bsuid = ?",
  params: [userId, caller.businessPortfolioId, caller.businessScopedUserId],
});

const userUnavailable = (): Unavailable =>
  Unavailable.make({
    error: { code: "unavailable", message: "User data is temporarily unavailable. Retry later." },
    next: [],
  });

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

export const getCurrentUser = (
  userId: UserId
): Effect.Effect<CurrentUserResponse, Unavailable, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = yield* prepareCurrentUser(userId);
    const rows = yield* sql.unsafe(read.statement.sql, read.statement.params);

    return yield* read.decode(rows);
  }).pipe(Effect.mapError(userUnavailable));

export const liveWebSessionAuthority = (
  input: Readonly<{ subject: WebSessionSubject; current: number }>
): WebSessionAuthority => {
  const credential = webSessionCredentialAuthority(input);

  return protectConsentAuthority({
    authority: credential,
    subject: ConsentSubject.Owner({ column: "web_sessions.user_id" }),
    requirement: "unrevoked",
  });
};

export const userTrialPeriodQuery = (userId: UserId): OwnedStatement =>
  selectedUserTrialPeriodQuery({ sql: "SELECT ? AS userId", params: [userId] });

export const selectedUserTrialPeriodQuery = (users: OwnedStatement): OwnedStatement => ({
  sql: `SELECT trial_started_at_ms AS startedAtMs, trial_ends_at_ms AS endsAtMs
    FROM users WHERE id = (SELECT userId FROM (${users.sql})) AND trial_started_at_ms IS NOT NULL LIMIT 1`,
  params: users.params,
});

export const activeTrialPeriodCondition = ({
  userId,
  nowEpochMs,
}: Readonly<{ userId: UserId; nowEpochMs: number }>): OwnedStatement =>
  activeTrialPeriodForUserSelection({
    users: { sql: "SELECT ?", params: [userId] },
    nowEpochMs,
  });

export const activeTrialPeriodForUserSelection = ({
  users,
  nowEpochMs,
}: Readonly<{ users: OwnedStatement; nowEpochMs: number }>): OwnedStatement => ({
  sql: `EXISTS (SELECT 1 FROM users WHERE id IN (${users.sql})
    AND trial_started_at_ms <= ? AND trial_ends_at_ms > ?)`,
  params: [...users.params, nowEpochMs, nowEpochMs],
});

export const prepareSelectedCurrentUser = (users: OwnedStatement): PreparedCurrentUserRead => ({
  statement: selectedCurrentUserQuery(users),
  decode: (rows) =>
    decodeUser(rows[0]).pipe(
      Effect.map((data) => ({ data, next: [] as const })),
      Effect.mapError(userUnavailable)
    ),
});
