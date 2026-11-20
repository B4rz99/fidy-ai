import { type Cause, Effect, Schema } from "effect";
import { listLaunchCategories } from "../../../apps/server/src/core/categories/operations";
import type { Miniflare } from "miniflare";

type Owner = Pick<Awaited<ReturnType<Miniflare["unsafeGetDurableObjectStorage"]>>, "exec">;
export const subject = "24000000-0000-4000-8000-000000000481";
const epoch = Date.parse("2026-11-17T12:00:00Z");
const currencies = ["COP", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF"];
const sizes = {
  production: { transactions: 8, plans: 2, revisions: 2, review: 4, currencies: 2 },
  small: { transactions: 500, plans: 10, revisions: 1, review: 50, currencies: 2 },
  extreme: { transactions: 100000, plans: 100, revisions: 100, review: 5000, currencies: 8 },
  breaking: { transactions: 1000000, plans: 100, revisions: 100, review: 5000, currencies: 8 },
};
type Size = typeof sizes.small;
const chunk = 500;
const idDigits = 12;
const retentionDays = 90;
const dayMs = 86400000;
const digestCharacters = 64;
const execute = (
  db: Owner,
  ...args: Parameters<Owner["exec"]>
): Effect.Effect<Awaited<ReturnType<Owner["exec"]>>, Cause.UnknownError> =>
  Effect.tryPromise(() => db.exec(...args));
const everyHundred = 100;
// Match the immutable D1 fixture's IDs, facts and dates. Bound each native SQLite statement.
type FinancialFixture = { subject: string; segment: string; d1: boolean; retainedReview: number };
const transactions = Effect.fn(function* (
  db: Owner,
  size: Size,
  { subject, segment, d1 }: FinancialFixture
) {
  const encodedCurrencies = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(Schema.String))
  )(currencies);
  for (let start = 0; start < size.transactions; start += chunk) {
    yield* execute(
      db,
      `WITH RECURSIVE series(i) AS (
      VALUES(CAST(?1 AS INTEGER)) UNION ALL SELECT i+1 FROM series WHERE i+1 < ?2
    ), facts AS (SELECT i,CASE WHEN i%100=1 THEN i-1 ELSE i END AS p FROM series),
    dated AS (SELECT *,?3-CASE WHEN p<500 THEN p*60000 ELSE ((p%3650)+1)*86400000 END AS occurred FROM facts)
    INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms)
    SELECT printf('81000000-0000-4000-${segment}-%012d',i),?4,'1000',
    json_extract(?5,printf('$[%d]', p%?6)),'outflow','Evaluación ' || p,
    printf('10000000-0000-4000-8000-%012d',CASE WHEN p%3=0 THEN 1 ELSE (p%15)+2 END),occurred,occurred FROM dated`,
      start,
      Math.min(start + chunk, size.transactions),
      epoch,
      subject,
      encodedCurrencies,
      size.currencies
    );
  }
  yield* execute(
    db,
    `WITH RECURSIVE pairs(i) AS (
    VALUES(0) UNION ALL SELECT i+100 FROM pairs WHERE i+100 < ?1
  ) INSERT INTO transaction_reconciliation_decisions
    SELECT ?2,printf('81000000-0000-4000-${segment}-%012d',i),
    printf('81000000-0000-4000-${segment}-%012d',i+1),'linked',printf('81000000-0000-4000-${segment}-%012d',i),?3 FROM pairs`,
    size.transactions,
    subject,
    epoch
  );
  for (const member of ["first_transaction_id", "second_transaction_id"] as const) {
    yield* execute(
      db,
      `UPDATE transactions SET reconciliation_first_id=d.first_transaction_id,reconciliation_second_id=d.second_transaction_id
      FROM transaction_reconciliation_decisions d WHERE transactions.user_id=d.user_id AND transactions.id=d.${member} AND d.user_id=?`,
      subject
    );
  }
  if (d1) return;
  // The native Reconciliation writer explicitly updates the affected leaves. Both synthetic members have identical facts.
  yield* execute(
    db,
    `DELETE FROM transaction_projection_leaf WHERE id IN (SELECT second_transaction_id FROM transaction_reconciliation_decisions)`
  );
});
const planning = Effect.fn(function* (
  db: Owner,
  size: Size,
  { subject, segment, d1 }: FinancialFixture
) {
  for (const [index, currency] of currencies.slice(0, size.currencies).entries()) {
    yield* execute(
      db,
      `INSERT INTO budgets(id,user_id,category_id,${d1 ? "" : "category_revision,"}currency,cap,created_at_ms,updated_at_ms,group_name,starts_month)
      SELECT printf('82000000-0000-4000-${segment}-%012d',?1*16+row_number() OVER(ORDER BY id)),?2,id,${d1 ? "" : "'co-1',"}?3,'100000',?4,?4,'Grupo ' || ?3,'2016-01' FROM categories LIMIT 16`,
      index,
      subject,
      currency,
      epoch
    );
  }
  yield* execute(
    db,
    `INSERT INTO user_documents VALUES(?,'recurring-plan','{"excludedTransactionIds":[],"suggestions":[]}',1)`,
    subject
  );
  for (let index = 0; index < size.plans; index++) {
    const id = `83000000-0000-4000-${segment}-` + String(index).padStart(idDigits, "0");
    yield* execute(
      db,
      "INSERT INTO recurring_plans(user_id,id,position,pauses_json) VALUES(?,?,?,'[]')",
      subject,
      id,
      index
    );
    yield* execute(
      db,
      `WITH RECURSIVE revisions(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM revisions WHERE n+1<?1),
      dates AS (SELECT n,date('2018-01-01','+' || n || ' months') AS start FROM revisions)
      INSERT INTO recurring_plan_revisions(user_id,plan_id,position,from_date,plan_json)
      SELECT ?2,?3,n,start,json_object('name',printf('Recurrente %d',?4),'kind','expense','currency','COP','amountMode','fixed',
      'money',json_object('amount','100000','currency','COP'),'frequency','monthly','firstDate',start,'timeZone','America/Bogota',
      'counterparty',printf('Contraparte %d',?4)) FROM dates`,
      size.revisions,
      subject,
      id,
      index
    );
  }
});
const reviewSubmission = Effect.fn(function* (
  db: Owner,
  { subject, segment }: FinancialFixture,
  { start, end, expired }: { start: number; end: number; expired: boolean }
) {
  const suffix = String(start).padStart(idDigits, "0");
  const staging = `84000000-0000-4000-${segment}-${suffix}`;
  const submission = `85000000-0000-4000-${segment}-${suffix}`;
  const retentionMs = retentionDays * dayMs;
  const created = expired ? epoch - retentionMs : epoch;
  const expires = created + retentionMs;
  yield* execute(
    db,
    `INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,source_format,status,created_at_ms,expires_at_ms,published_submission_id)
    VALUES(?1,?2,?7,1,?3,'csv','published',?4,?5,?6)`,
    staging,
    subject,
    "a".repeat(digestCharacters),
    created,
    expires,
    submission,
    segment === "8000" && start === 0
      ? "synthetic-assessment-original"
      : "synthetic-assessment-original-" + staging
  );
  yield* execute(
    db,
    `INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,status,retention_expires_at_ms)
    VALUES(?,?,'86000000-0000-4000-${segment}-${suffix}',?,?,'csv','statement-parser-v1','CO','es-CO','America/Bogota','queued',?)`,
    submission,
    subject,
    staging,
    created,
    expires
  );
  yield* execute(
    db,
    `WITH RECURSIVE items(i) AS (VALUES(CAST(?6 AS INTEGER)) UNION ALL SELECT i+1 FROM items WHERE i+1<?1)
    INSERT INTO ingestion_review_items(source_kind,id,user_id,statement_submission_id,record_number,reason,original_evidence,issues_json,evidence_state,evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision)
    SELECT 'statement',printf('87000000-0000-4000-${segment}-%012d',i),?2,?3,i+1-?6,'mapping-unavailable',
    CASE WHEN ?7=0 THEN 'Original sintético ' || i || ': 2026-10-01,25000,Mercado' END,'[]',CASE WHEN ?7=0 THEN 'retained' ELSE 'expired' END,?4,?5,'CO','es-CO','America/Bogota','csv','statement-parser-v1','statement-mechanical-v1' FROM items`,
    end,
    subject,
    submission,
    expires,
    created,
    start,
    Number(expired)
  );
});
const reviews = Effect.fn(function* (db: Owner, size: Size, fixture: FinancialFixture) {
  if (fixture.retainedReview > 0) {
    yield* reviewSubmission(db, fixture, { start: 0, end: fixture.retainedReview, expired: false });
  }
  if (fixture.retainedReview < size.review) {
    yield* reviewSubmission(db, fixture, {
      start: fixture.retainedReview,
      end: size.review,
      expired: true,
    });
  }
});
const prepareStanding = Effect.fn(function* (db: Owner, { subject: user, d1 }: FinancialFixture) {
  // The pinned D1 journey grants this User an active trial before browser approval.
  yield* execute(
    db,
    "UPDATE users SET trial_started_at_ms=created_at_ms,trial_ends_at_ms=created_at_ms+604800000 WHERE id=?",
    user
  );
  // Native captures retain stable Category keys on demand. The direct fixture writes bypass capture.
  for (const [position, category] of (d1 ? [] : listLaunchCategories()).entries()) {
    yield* execute(
      db,
      "INSERT INTO categories(id,label,display_order) VALUES(?,?,?)",
      category.id,
      category.label,
      position
    );
  }
});
const maxUsers = 256,
  hexRadix = 16;
const validSize = (dataset: string): dataset is keyof typeof sizes => Object.hasOwn(sizes, dataset);
const defaultUser = { subject, index: 0, d1: false, mixedReview: false };
export const financialFixtureCounts = Effect.fn(function* (db: Owner, user: string) {
  const [counts] = yield* execute(
    db,
    `SELECT (SELECT count(*) FROM transactions WHERE user_id=?1) AS transactions,
    (SELECT count(DISTINCT currency) FROM transactions WHERE user_id=?1) AS currencies,
    (SELECT count(*) FROM transaction_projection_leaf WHERE user_id=?1) AS effectiveTransactions,
    (SELECT count(*) FROM transaction_reconciliation_decisions WHERE user_id=?1 AND state='linked') AS links,
    (SELECT count(*) FROM recurring_plans WHERE user_id=?1) AS plans,
    (SELECT count(*) FROM recurring_plan_revisions WHERE user_id=?1) AS revisions,
    (SELECT count(*) FROM ingestion_review_items WHERE user_id=?1) AS review,
    (SELECT count(*) FROM ingestion_review_items WHERE user_id=?1 AND evidence_state='retained') AS retainedReview`,
    user
  );
  return counts;
});
export const seed = Effect.fn(function* (db: Owner, dataset: string, config = defaultUser) {
  const { subject: user, index, d1 } = config;
  if (!Number.isInteger(index) || index < 0 || index >= maxUsers) {
    return yield* Effect.die("Invalid fixture User index");
  }
  if (!validSize(dataset)) return yield* Effect.die("Unknown fixture size");
  const size = sizes[dataset];
  const cohortSize = 20;
  const retainedReview = config.mixedReview ? Math.floor(size.review / cohortSize) : size.review;
  const fixture = {
    retainedReview,
    subject: user,
    segment: "80" + index.toString(hexRadix).padStart(2, "0"),
    d1,
  };
  const start = performance.now();
  yield* prepareStanding(db, fixture);
  process.stdout.write("REFERENCE_STAGE transactions\n");
  yield* transactions(db, size, fixture);
  process.stdout.write("REFERENCE_STAGE planning\n");
  yield* planning(db, size, fixture);
  process.stdout.write("REFERENCE_STAGE reviews\n");
  yield* reviews(db, size, fixture);
  process.stdout.write("REFERENCE_STAGE counts\n");
  const counts = yield* financialFixtureCounts(db, user);
  const links = Math.ceil(size.transactions / everyHundred);
  const verified = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      transactions: Schema.Literal(size.transactions),
      currencies: Schema.Literal(size.currencies),
      effectiveTransactions: Schema.Literal(size.transactions - links),
      links: Schema.Literal(links),
      plans: Schema.Literal(size.plans),
      revisions: Schema.Literal(size.plans * size.revisions),
      review: Schema.Literal(size.review),
    })
  )(counts);
  return { dataset, seedEpochMs: epoch, ...verified, milliseconds: performance.now() - start };
});
