import { type Cause, Effect, Schema } from "effect";
import { listLaunchCategories } from "../../../apps/server/src/core/categories/operations";
import type { Miniflare } from "miniflare";

type Owner = Awaited<ReturnType<Miniflare["unsafeGetDurableObjectStorage"]>>;

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

const transactions = Effect.fn(function* (db: Owner, size: Size) {
  const encodedCurrencies = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(Schema.String))
  )(currencies);

  yield* Effect.forEach(
    Array.from({ length: Math.ceil(size.transactions / chunk) }, (_, index) => index * chunk),
    (start) =>
      execute(
        db,
        `WITH RECURSIVE series(i) AS (
      VALUES(CAST(?1 AS INTEGER)) UNION ALL SELECT i+1 FROM series WHERE i+1 < ?2
    ), facts AS (SELECT i,CASE WHEN i%100=1 THEN i-1 ELSE i END AS p FROM series),
    dated AS (SELECT *,?3-CASE WHEN p<500 THEN p*60000 ELSE ((p%3650)+1)*86400000 END AS occurred FROM facts)
    INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms)
    SELECT printf('81000000-0000-4000-8000-%012d',i),?4,'1000',
    json_extract(?5,printf('$[%d]', p%?6)),'outflow','Evaluación ' || p,
    printf('10000000-0000-4000-8000-%012d',CASE WHEN p%3=0 THEN 1 ELSE (p%15)+2 END),occurred,occurred FROM dated`,
        start,
        Math.min(start + chunk, size.transactions),
        epoch,
        subject,
        encodedCurrencies,
        size.currencies
      ),
    { discard: true }
  );

  yield* execute(
    db,
    `WITH RECURSIVE pairs(i) AS (
    VALUES(0) UNION ALL SELECT i+100 FROM pairs WHERE i+100 < ?1
  ) INSERT INTO transaction_reconciliation_decisions
    SELECT ?2,printf('81000000-0000-4000-8000-%012d',i),
    printf('81000000-0000-4000-8000-%012d',i+1),'linked',printf('81000000-0000-4000-8000-%012d',i),?3 FROM pairs`,
    size.transactions,
    subject,
    epoch
  );

  yield* Effect.forEach(
    ["first_transaction_id", "second_transaction_id"] as const,
    (member) =>
      execute(
        db,
        `UPDATE transactions SET reconciliation_first_id=d.first_transaction_id,reconciliation_second_id=d.second_transaction_id
      FROM transaction_reconciliation_decisions d WHERE transactions.user_id=d.user_id AND transactions.id=d.${member}`
      ),
    { discard: true }
  );

  yield* execute(
    db,
    `DELETE FROM transaction_projection_leaf WHERE id IN (SELECT second_transaction_id FROM transaction_reconciliation_decisions)`
  );
});

const planning = Effect.fn(function* (db: Owner, size: Size) {
  yield* Effect.forEach(
    currencies.slice(0, size.currencies),
    (currency, index) =>
      execute(
        db,
        `INSERT INTO budgets(id,user_id,category_id,category_revision,currency,cap,created_at_ms,updated_at_ms,group_name,starts_month)
      SELECT printf('82000000-0000-4000-8000-%012d',?1*16+row_number() OVER(ORDER BY id)),?2,id,'co-1',?3,'100000',?4,?4,'Grupo ' || ?3,'2016-01' FROM categories LIMIT 16`,
        index,
        subject,
        currency,
        epoch
      ),
    { discard: true }
  );

  yield* execute(
    db,
    `INSERT INTO user_documents VALUES(?,'recurring-plan','{"excludedTransactionIds":[],"suggestions":[]}',1)`,
    subject
  );

  yield* Effect.forEach(
    Array.from({ length: size.plans }, (_, index) => index),
    (index) =>
      Effect.gen(function* () {
        const id = "83000000-0000-4000-8000-" + String(index).padStart(idDigits, "0");
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
      }),
    { discard: true }
  );
});

const reviews = Effect.fn(function* (db: Owner, size: Size) {
  const staging = "84000000-0000-4000-8000-000000000000";
  const submission = "85000000-0000-4000-8000-000000000000";
  const retentionMs = retentionDays * dayMs;
  const expires = epoch + retentionMs;
  yield* execute(
    db,
    `INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,source_format,status,created_at_ms,expires_at_ms,published_submission_id)
    VALUES(?,?,'synthetic-assessment-original',1,?,'csv','published',?,?,?)`,
    staging,
    subject,
    "a".repeat(digestCharacters),
    epoch,
    expires,
    submission
  );
  yield* execute(
    db,
    `INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,status,retention_expires_at_ms)
    VALUES(?,?,'86000000-0000-4000-8000-000000000000',?,?,'csv','statement-parser-v1','CO','es-CO','America/Bogota','queued',?)`,
    submission,
    subject,
    staging,
    epoch,
    expires
  );
  yield* execute(
    db,
    `WITH RECURSIVE items(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM items WHERE i+1<?1)
    INSERT INTO ingestion_review_items(source_kind,id,user_id,statement_submission_id,record_number,reason,original_evidence,issues_json,evidence_state,evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision)
    SELECT 'statement',printf('87000000-0000-4000-8000-%012d',i),?2,?3,i+1,'mapping-unavailable',
    'Original sintético ' || i || ': 2026-10-01,25000,Mercado','[]','retained',?4,?5,'CO','es-CO','America/Bogota','csv','statement-parser-v1','statement-mechanical-v1' FROM items`,
    size.review,
    subject,
    submission,
    expires,
    epoch
  );
});

const seedCategories = Effect.fn(function* (db: Owner) {
  yield* Effect.forEach(
    listLaunchCategories(),
    (category, position) =>
      execute(
        db,
        "INSERT INTO categories(id,label,display_order) VALUES(?,?,?)",
        category.id,
        category.label,
        position
      ),
    { discard: true }
  );
});

export const seed = Effect.fn(function* (db: Owner, dataset: string) {
  if (
    dataset !== "small" &&
    dataset !== "production" &&
    dataset !== "extreme" &&
    dataset !== "breaking"
  ) {
    return yield* Effect.die("Unknown fixture size");
  }

  const size = sizes[dataset];
  const start = performance.now();
  yield* execute(
    db,
    "UPDATE users SET trial_started_at_ms=created_at_ms,trial_ends_at_ms=created_at_ms+604800000 WHERE id=?",
    subject
  );

  yield* seedCategories(db);

  process.stdout.write("REFERENCE_STAGE transactions\n");
  yield* transactions(db, size);
  process.stdout.write("REFERENCE_STAGE planning\n");
  yield* planning(db, size);
  process.stdout.write("REFERENCE_STAGE reviews\n");
  yield* reviews(db, size);
  process.stdout.write("REFERENCE_STAGE counts\n");

  const [counts] = yield* execute(
    db,
    `SELECT (SELECT count(*) FROM transactions) AS transactions,
    (SELECT count(DISTINCT currency) FROM transactions) AS currencies,
    (SELECT count(*) FROM transaction_projection_leaf) AS effectiveTransactions,
    (SELECT count(*) FROM transaction_reconciliation_decisions WHERE state='linked') AS links,
    (SELECT count(*) FROM recurring_plans) AS plans,
    (SELECT count(*) FROM recurring_plan_revisions) AS revisions,
    (SELECT count(*) FROM ingestion_review_items) AS review`
  );

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
