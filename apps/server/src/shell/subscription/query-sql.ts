import { Option } from "effect";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";

type Authority = Readonly<{
  table: "pats" | "web_sessions";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;
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
}>): OwnedStatement => ({
  sql: `SELECT t.started_at_ms, t.ends_at_ms AS trial_ends_at_ms,
    s.price_id, a.amount, a.currency, a.billing_period, a.service_market, a.tax_treatment,
    p.starts_at_ms, p.ends_at_ms, p.renewal_anchor_ms
    FROM trial_periods AS t LEFT JOIN subscriptions AS s ON s.user_id = t.user_id
    LEFT JOIN billing_attempts AS a ON a.id = s.attempt_id AND a.user_id = t.user_id
    LEFT JOIN billing_paid_periods AS p ON p.attempt_id = a.id
    WHERE t.user_id = ?${guard(authority)} LIMIT 1`,
  params: [userId, ...bindings(authority)],
});

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
