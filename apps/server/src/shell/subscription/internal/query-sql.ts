import { activeProGrantSelection } from "~/shell/pro-grants/operations";
import { renewalGraceMs } from "~/core/subscription/contract";
import { UserId } from "~/core/identity/contract";
import { Option, Schema } from "effect";
import { selectedUserTrialPeriodQuery } from "~/shell/identity/operations";
import { type OwnedStatement } from "~/shell/owner-write/contract";
import { type SubscriptionReadAuthority as Authority } from "~/shell/subscription/contract";

const guard = (authority: Option.Option<Authority>): string =>
  Option.match(authority, {
    onNone: () => "",
    onSome: ({ table, predicate }) => ` AND EXISTS (SELECT 1 FROM ${table} WHERE ${predicate})`,
  });
const bindings = (
  authority: Option.Option<Authority>
): ReadonlyArray<string | number | Uint8Array> =>
  Option.match(authority, { onNone: () => [], onSome: (value) => value.bindings });

export const paidAccessEndSql = `MIN(a.paid_ends_at_ms, COALESCE(
  (SELECT MIN(adjustment.access_ends_at_ms) FROM refund_attempts adjustment WHERE adjustment.access_ends_at_ms IS NOT NULL AND adjustment.billing_attempt_id=a.id), a.paid_ends_at_ms))
  + CASE WHEN NOT EXISTS (SELECT 1 FROM subscription_renewal_fences stop WHERE stop.user_id=s.user_id)
    AND NOT EXISTS (SELECT 1 FROM refund_attempts adjustment WHERE adjustment.access_ends_at_ms IS NOT NULL AND adjustment.billing_attempt_id=a.id)
    THEN ${renewalGraceMs} ELSE 0 END`;

/** Published Prices are ordered and capped before projection as a complete three-Price set. */
export const subscriptionOffersQuery = (
  authority: Option.Option<Authority> = Option.none()
): OwnedStatement => ({
  sql: `SELECT id, amount, currency, billing_period, service_market, tax_treatment, terms_json
    FROM subscription_prices WHERE published_order IS NOT NULL${guard(authority)}
    ORDER BY published_order LIMIT 4`,
  params: bindings(authority),
});

/** One User's original trial and latest paid period, guarded by the caller's live authority. */
export const subscriptionStandingQuery = (
  input: Readonly<{ authority: Option.Option<Authority> }> &
    (Readonly<{ userId: string }> | Readonly<{ users: OwnedStatement }>)
): OwnedStatement => {
  const { authority } = input;
  if ("userId" in input && Option.isNone(Schema.decodeOption(UserId)(input.userId))) {
    return { sql: "SELECT NULL WHERE 0", params: [] };
  }
  const users =
    "users" in input ? input.users : { sql: "SELECT ? AS userId", params: [input.userId] };
  const trial = selectedUserTrialPeriodQuery({ sql: "SELECT userId FROM owner", params: [] });
  const grant = activeProGrantSelection({ sql: "SELECT userId FROM owner", params: [] });
  return {
    sql: `WITH owner AS MATERIALIZED (${users.sql}) SELECT ${grant.sql} AS has_pro_grant, t.startedAtMs AS started_at_ms, t.endsAtMs AS trial_ends_at_ms,
      s.price_id, a.amount, a.currency, a.billing_period, a.service_market, a.tax_treatment,
      a.paid_starts_at_ms AS starts_at_ms,
      MIN(a.paid_ends_at_ms,COALESCE((SELECT MIN(adjustment.access_ends_at_ms) FROM refund_attempts adjustment
        WHERE adjustment.access_ends_at_ms IS NOT NULL AND adjustment.billing_attempt_id=a.id),a.paid_ends_at_ms)) AS ends_at_ms,
      a.paid_renewal_anchor_ms AS renewal_anchor_ms,
      ${paidAccessEndSql} AS access_ends_at_ms,
      c.cancelled_at_ms, c.paid_through_ms, c.source_cancellation
      FROM (${trial.sql}) AS t LEFT JOIN subscription_standing AS s ON s.user_id = (SELECT userId FROM owner)
      LEFT JOIN billing_attempt_context AS a ON a.id = s.attempt_id AND a.user_id = s.user_id
      LEFT JOIN payment_source_context AS source ON source.id = a.payment_source_id AND source.user_id = a.user_id
      LEFT JOIN subscription_cancellation_context AS c ON c.user_id=s.user_id AND c.subscription_id=a.subscription_id
      WHERE TRUE${guard(authority)} LIMIT 1`,
    params: [...users.params, ...grant.params, ...trial.params, ...bindings(authority)],
  };
};

/** At most ten recent attempts for the resolved User, never provider or payment-source ids. */
export const subscriptionAttemptsQuery = (
  input: Readonly<{ authority: Option.Option<Authority> }> &
    (Readonly<{ userId: string }> | Readonly<{ users: OwnedStatement }>)
): OwnedStatement => {
  const { authority } = input;
  const users =
    "users" in input ? input.users : { sql: "SELECT ? AS userId", params: [input.userId] };
  return {
    sql: `SELECT a.id, a.price_id, a.amount, a.currency, a.billing_period,
    a.service_market, a.tax_treatment, a.time_zone, a.created_at_ms, a.status, a.finalized_at_ms,
    a.paid_ends_at_ms AS ends_at_ms, a.paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempt_context AS a
    WHERE a.user_id = (SELECT userId FROM (${users.sql}))${guard(authority)} ORDER BY a.created_at_ms DESC, a.id DESC LIMIT 10`,
    params: [...users.params, ...bindings(authority)],
  };
};
