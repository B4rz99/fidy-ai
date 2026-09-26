import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import {
  livePATAuthority,
  recordCanonicalPATWork,
  recordLivePATUse,
} from "@fidy/server/tokens-runtime";
import {
  SubscriptionOffers,
  SubscriptionStatus,
  projectSubscriptionOffers,
  projectSubscriptionStatus,
} from "@fidy/server/subscription-runtime";
import { Schema } from "effect";
import { prepareOwnedStatement } from "../pats/pat-unit";
import { currentMillis, newId } from "../pats/pat-shared";
import { type TransactionCaller, isPATCaller } from "../transactions/transaction-boundary";

const headers = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" };
const unavailable = (): Response =>
  Response.json(
    {
      error: {
        code: "unavailable",
        message: "Subscription data is temporarily unavailable. Retry later.",
      },
      next: [],
    },
    { status: 503, headers }
  );
const refused = (): Response =>
  Response.json(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    { status: 401, headers }
  );
const selectOffers = `SELECT id, amount, currency, billing_period, service_market, tax_treatment, terms_json
  FROM subscription_prices WHERE published_order IS NOT NULL`;
const selectStanding = `SELECT t.started_at_ms, t.ends_at_ms AS trial_ends_at_ms,
    s.price_id, a.amount, a.currency, a.billing_period, a.service_market, a.tax_treatment,
    p.starts_at_ms, p.ends_at_ms, p.renewal_anchor_ms
    FROM trial_periods AS t LEFT JOIN subscriptions AS s ON s.user_id = t.user_id
    LEFT JOIN billing_attempts AS a ON a.id = s.attempt_id AND a.user_id = t.user_id
    LEFT JOIN billing_paid_periods AS p ON p.attempt_id = a.id
    WHERE t.user_id = ?`;
const selectAttempts = `SELECT a.id, a.price_id, a.amount, a.currency, a.billing_period,
    a.service_market, a.tax_treatment, a.time_zone, a.created_at_ms, a.status, a.finalized_at_ms,
    p.ends_at_ms, p.renewal_anchor_ms FROM billing_attempts AS a
    LEFT JOIN billing_paid_periods AS p ON p.attempt_id = a.id
    WHERE a.user_id = ?`;
const auditResultIndex = -1;
const patUseResultIndex = -2;
type SubscriptionQuery =
  | "subscription.listSubscriptionOffers"
  | "subscription.getSubscriptionStatus";
type QueryInput = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: SubscriptionQuery;
}>;

const subscriptionStatements = (
  { db, subject, operation }: QueryInput,
  current: number
): ReadonlyArray<D1PreparedStatement> => {
  const pat = isPATCaller(subject);
  const authority = pat
    ? livePATAuthority({ subject, current })
    : liveWebSessionAuthority({ subject, current });
  const exists = `EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`;
  const work =
    operation === "subscription.listSubscriptionOffers"
      ? [
          db
            .prepare(`${selectOffers} AND ${exists} ORDER BY published_order LIMIT 4`)
            .bind(...authority.bindings),
        ]
      : [
          db
            .prepare(`${selectStanding} AND ${exists} LIMIT 1`)
            .bind(subject.userId, ...authority.bindings),
          db
            .prepare(
              `${selectAttempts} AND ${exists} ORDER BY a.created_at_ms DESC, a.id DESC LIMIT 10`
            )
            .bind(subject.userId, ...authority.bindings),
        ];
  const use = pat
    ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
    : [];
  const audit = pat
    ? prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          subject,
          input: { id: newId(), current, operation, outcome: "accepted", afterOwnerWrite: false },
        }),
      })
    : db
        .prepare(`INSERT INTO pat_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
        SELECT ?, user_id, id, ?, 'accepted', ? FROM web_sessions WHERE ${authority.predicate}`)
        .bind(newId(), operation, current, ...authority.bindings);
  return [...work, ...use, audit];
};

const subscriptionData = ({
  results,
  operation,
  current,
}: Readonly<{
  results: ReadonlyArray<D1Result>;
  operation: SubscriptionQuery;
  current: number;
}>): unknown =>
  operation === "subscription.listSubscriptionOffers"
    ? Schema.encodeSync(Schema.toCodecJson(SubscriptionOffers))(
        projectSubscriptionOffers(results[0]?.results ?? [])
      )
    : Schema.encodeSync(Schema.toCodecJson(SubscriptionStatus))(
        projectSubscriptionStatus({
          standingRow: results[0]?.results[0],
          attemptRows: results[1]?.results ?? [],
          now: current,
        })
      );

const presentSubscription = ({
  results,
  operation,
  current,
  pat,
}: Readonly<{
  results: ReadonlyArray<D1Result>;
  operation: SubscriptionQuery;
  current: number;
  pat: boolean;
}>): Response => {
  if (
    results.at(auditResultIndex)?.meta.changes !== 1 ||
    (pat && results.at(patUseResultIndex)?.meta.changes !== 1)
  ) {
    return refused();
  }
  // The canonical codec rebuilds a closed JSON response, excluding provider and payment-source ids.
  return Response.json(
    { data: subscriptionData({ results, operation, current }), next: [] },
    { headers }
  );
};

/** Commit one bounded query and its metadata-only AuditLogEntry under the same live User authority. */
// @effect-diagnostics-next-line asyncFunction:off
export const executeProtectedSubscriptionQuery = async (input: QueryInput): Promise<Response> => {
  const current = currentMillis();
  try {
    const results = await input.db.batch([...subscriptionStatements(input, current)]);
    return presentSubscription({
      results,
      operation: input.operation,
      current,
      pat: isPATCaller(input.subject),
    });
  } catch {
    return unavailable();
  }
};
