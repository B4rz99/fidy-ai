import { providerContactUsers } from "~/shell/provider-authentication/operations";
import { verifiedEmailUsers } from "~/shell/email-authentication/operations";
import { existingUserSelection } from "~/shell/identity/operations";
import { UserId } from "~/core/identity/contract";
import { Clock, Effect, Schema } from "effect";
import {
  ProCommand,
  ProGrantEntry,
  ProGrantFailure,
  type ProGrantQuery,
  ProOperator,
  type ProStatement,
  maximumProGrants,
} from "./contract";
import { type OwnedStatement } from "~/shell/owner-write/contract";

/** Trusted operator only; resolves exactly one existing User in the same statement as the change. */
export const prepareProGrant = (
  input: Readonly<{
    action: "grant" | "revoke";
    selector: Readonly<{ userId: string }> | Readonly<{ email: string }>;
    operator: string;
    now: number;
  }>
): ProStatement => {
  const selected = selectProUser(input.selector);
  return {
    sql: `WITH candidates AS (${selected.sql})
      INSERT INTO pro_grant_events(user_id, action, operator, occurred_at_ms)
      SELECT userId, ?, ?, ? FROM candidates WHERE (SELECT COUNT(*) FROM candidates) = 1
      RETURNING user_id AS userId, action`,
    params: [...selected.params, input.action, input.operator, input.now],
  };
};

const selectProUser = (
  selector: Readonly<{ userId: string }> | Readonly<{ email: string }>
): ProStatement => {
  if ("userId" in selector) return existingUserSelection(selector.userId);
  const provider = providerContactUsers(selector.email);
  const verified = verifiedEmailUsers(selector.email);
  return {
    sql: `SELECT userId FROM (${provider.sql}) UNION SELECT userId FROM (${verified.sql})`,
    params: [...provider.params, ...verified.params],
  };
};

/** Compose current manual access into the protected caller's own snapshot; this is not authority. */
export const activeProGrantSelection = (users: OwnedStatement): OwnedStatement => ({
  sql: `EXISTS (SELECT 1 FROM pro_grant_events g WHERE g.user_id IN (${users.sql})
    AND g.action = 'grant' AND g.sequence =
      (SELECT MAX(latest.sequence) FROM pro_grant_events latest WHERE latest.user_id = g.user_id))`,
  params: users.params,
});

/** Bounded active grants only; no email, provider identity or billing details leave storage. */
export const listProGrants: ProStatement = {
  sql: `SELECT g.user_id AS userId, g.action FROM pro_grant_events g
    WHERE g.action = 'grant' AND g.sequence =
      (SELECT MAX(latest.sequence) FROM pro_grant_events latest WHERE latest.user_id = g.user_id)
    ORDER BY g.user_id LIMIT ${maximumProGrants + 1}`,
  params: [],
};

/** Executes operator intent with no retries; a failed transport may have committed the event. */
export const executeProCommand = Effect.fn(function* (
  input: Readonly<{
    command: unknown;
    operator: string;
    query: ProGrantQuery;
  }>
) {
  const invalid = (): ProGrantFailure =>
    new ProGrantFailure({ reason: "invalid-input", candidates: [] });
  const command = yield* Schema.decodeUnknownEffect(ProCommand)(input.command).pipe(
    Effect.mapError(invalid)
  );
  const operator = yield* Schema.decodeEffect(ProOperator)(input.operator).pipe(
    Effect.mapError(invalid)
  );
  const now = yield* Clock.currentTimeMillis;
  const statement =
    command.action === "list" ? listProGrants : prepareProGrant({ ...command, operator, now });
  const rows = yield* input.query(statement);
  const entries = yield* Schema.decodeUnknownEffect(
    Schema.Array(ProGrantEntry).check(Schema.isMaxLength(maximumProGrants))
  )(rows).pipe(
    Effect.mapError(() => new ProGrantFailure({ reason: "unavailable", candidates: [] }))
  );
  if (command.action !== "list" && entries.length === 0) {
    const selected = selectProUser(command.selector);
    const candidates = yield* input.query({
      sql: `SELECT userId FROM (${selected.sql}) ORDER BY userId LIMIT 2`,
      params: selected.params,
    });
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ userId: UserId }))
    )(candidates).pipe(
      Effect.mapError(() => new ProGrantFailure({ reason: "unavailable", candidates: [] }))
    );
    return yield* new ProGrantFailure({
      reason: decoded.length > 1 ? "ambiguous-email" : "user-not-found",
      candidates: decoded.map((candidate) => candidate.userId),
    });
  }
  return entries;
});
