import { UserId } from "~/core/identity/contract";
import { Option, Schema } from "effect";
import { userTrialPeriodQuery } from "~/shell/identity/operations";
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
export const subscriptionStandingQuery = ({
  userId,
  authority,
}: Readonly<{
  userId: string;
  authority: Option.Option<Authority>;
}>): OwnedStatement => {
  const subject = Schema.decodeOption(UserId)(userId);
  if (Option.isNone(subject)) return { sql: "SELECT NULL WHERE 0", params: [] };
  const trial = userTrialPeriodQuery(subject.value);
  return {
    sql: `SELECT t.startedAtMs AS started_at_ms, t.endsAtMs AS trial_ends_at_ms,
      s.price_id, a.amount, a.currency, a.billing_period, a.service_market, a.tax_treatment,
      p.starts_at_ms,
      MIN(p.ends_at_ms,COALESCE((SELECT MIN(adjustment.ends_at_ms) FROM billing_access_adjustments adjustment
        WHERE adjustment.attempt_id=p.attempt_id),p.ends_at_ms)) AS ends_at_ms,
      p.renewal_anchor_ms
      FROM (${trial.sql}) AS t LEFT JOIN subscriptions AS s ON s.user_id = ?
      LEFT JOIN billing_attempts AS a ON a.id = s.attempt_id AND a.user_id = s.user_id
      LEFT JOIN billing_paid_periods AS p ON p.attempt_id = a.id
      WHERE TRUE${guard(authority)} LIMIT 1`,
    params: [...trial.params, userId, ...bindings(authority)],
  };
};

/** At most ten recent attempts for the resolved User, never provider or payment-source ids. */
export const subscriptionAttemptsQuery = ({
  userId,
  authority,
}: Readonly<{
  userId: string;
  authority: Option.Option<Authority>;
}>): OwnedStatement => ({
  sql: `SELECT a.id, a.price_id, a.amount, a.currency, a.billing_period,
    a.service_market, a.tax_treatment, a.time_zone, a.created_at_ms, a.status, a.finalized_at_ms,
    p.ends_at_ms, p.renewal_anchor_ms FROM billing_attempts AS a
    LEFT JOIN billing_paid_periods AS p ON p.attempt_id = a.id
    WHERE a.user_id = ?${guard(authority)} ORDER BY a.created_at_ms DESC, a.id DESC LIMIT 10`,
  params: [userId, ...bindings(authority)],
});
