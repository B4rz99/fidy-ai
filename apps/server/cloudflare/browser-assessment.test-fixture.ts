import { DateTime, Effect, Schema } from "effect";

const sizes = {
  small: { transactions: 500, plans: 10, revisions: 1, review: 50, currencies: 1 },
  heavy: { transactions: 10_000, plans: 100, revisions: 12, review: 1000, currencies: 4 },
  extreme: { transactions: 100_000, plans: 100, revisions: 100, review: 5000, currencies: 8 },
  breaking: { transactions: 1_000_000, plans: 100, revisions: 100, review: 5000, currencies: 8 },
};
type DatasetSize = typeof sizes.small;
const user = "24000000-0000-4000-8000-000000000481";
const uuidWidth = 12;
const categoryCount = 16;
const batchSize = 10_000;
const recentCount = 500;
const minuteMs = 60_000;
const dayMs = 86_400_000;
const historyDays = 3650;
const retentionDays = 90;
const shaLength = 64;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const uuid = (prefix: string, index: number): string =>
  `${prefix}-0000-4000-8000-${String(index).padStart(uuidWidth, "0")}`;
const seedTransactions = Effect.fn(function* (db: D1Database, size: DatasetSize, now: number) {
  for (let offset = 0; offset < size.transactions; offset += batchSize) {
    const rows = Array.from(
      { length: Math.min(batchSize, size.transactions - offset) },
      (_, index) => {
        const ordinal = offset + index;
        return {
          id: uuid("81000000", ordinal),
          category: `10000000-0000-4000-8000-${String((ordinal % categoryCount) + 1).padStart(uuidWidth, "0")}`,
          counterparty: `Evaluación ${ordinal}`,
          occurred:
            now - (ordinal < recentCount ? ordinal * minuteMs : (ordinal % historyDays) * dayMs),
        };
      }
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms)
      SELECT json_extract(value,'$.id'),?,'1000','COP','outflow',json_extract(value,'$.counterparty'),json_extract(value,'$.category'),json_extract(value,'$.occurred'),json_extract(value,'$.occurred') FROM json_each(?)`)
        .bind(user, json(rows))
        .run()
    );
  }
});
const seedBudgets = Effect.fn(function* (db: D1Database, size: DatasetSize, now: number) {
  const currencies = ["COP", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF"].slice(
    0,
    size.currencies
  );
  for (const [index, currency] of currencies.entries()) {
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO budgets(id,user_id,category_id,currency,cap,created_at_ms,updated_at_ms,group_name,starts_month)
      SELECT printf('82000000-0000-4000-8000-%012d',?*16+row_number() OVER (ORDER BY id)),?,id,?,'100000',?,?,?,'2016-01' FROM categories LIMIT 16`)
        .bind(index, user, currency, now, now, `Grupo ${currency}`)
        .run()
    );
  }
});
const planRevisions = (size: DatasetSize, index: number): string =>
  json(
    Array.from({ length: size.revisions }, (_, revision) => {
      const from = DateTime.formatIsoDateUtc(
        DateTime.add(DateTime.makeUnsafe("2018-01-01"), { months: revision })
      );
      return {
        from,
        plan: {
          name: `Recurrente ${index}`,
          kind: "expense",
          currency: "COP",
          amountMode: "fixed",
          money: { amount: "100000", currency: "COP" },
          frequency: "monthly",
          firstDate: from,
          timeZone: "America/Bogota",
          counterparty: `Contraparte ${index}`,
        },
      };
    })
  );
const seedRecurring = Effect.fn(function* (db: D1Database, size: DatasetSize) {
  yield* Effect.tryPromise(() =>
    db
      .prepare(
        "INSERT INTO user_documents VALUES(?,'recurring-plan','{\"excludedTransactionIds\":[],\"suggestions\":[]}',1)"
      )
      .bind(user)
      .run()
  );
  for (let index = 0; index < size.plans; index++) {
    const id = uuid("83000000", index);
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO recurring_plans(user_id,id,position,pauses_json) VALUES(?,?,?,'[]')"
          )
          .bind(user, id, index),
        db
          .prepare(
            "INSERT INTO recurring_plan_revisions(user_id,plan_id,position,from_date,plan_json) SELECT ?,?,CAST(key AS INTEGER),json_extract(value,'$.from'),json_extract(value,'$.plan') FROM json_each(?)"
          )
          .bind(user, id, planRevisions(size, index)),
      ])
    );
  }
});
const seedReview = Effect.fn(function* (db: D1Database, size: DatasetSize, now: number) {
  const staging = uuid("84000000", 0);
  const submission = uuid("85000000", 0);
  const expires = now + retentionDays * dayMs;
  yield* Effect.tryPromise(() =>
    db
      .prepare(
        "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,source_format,status,created_at_ms,expires_at_ms,published_submission_id) VALUES(?,?,?,1,?,'csv','published',?,?,?)"
      )
      .bind(
        staging,
        user,
        "synthetic-assessment-original",
        "a".repeat(shaLength),
        now,
        expires,
        submission
      )
      .run()
  );
  yield* Effect.tryPromise(() =>
    db
      .prepare(
        "INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,status,retention_expires_at_ms) VALUES(?,?,?,?,?,'csv','statement-parser-v1','CO','es-CO','America/Bogota','queued',?)"
      )
      .bind(submission, user, uuid("86000000", 0), staging, now, expires)
      .run()
  );
  for (let offset = 0; offset < size.review; offset += 100) {
    const rows = Array.from({ length: Math.min(100, size.review - offset) }, (_, index) => ({
      id: uuid("87000000", offset + index),
      record: offset + index + 1,
      original: `Original sintético ${offset + index}: 2026-10-01,25000,Mercado`,
    }));
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO ingestion_review_items(source_kind,id,user_id,statement_submission_id,record_number,reason,original_evidence,issues_json,evidence_state,evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision)
      SELECT 'statement',json_extract(value,'$.id'),?,?,json_extract(value,'$.record'),'mapping-unavailable',json_extract(value,'$.original'),'[]','retained',?,?,'CO','es-CO','America/Bogota','csv','statement-parser-v1','statement-mechanical-v1' FROM json_each(?)`)
        .bind(user, submission, expires, now, json(rows))
        .run()
    );
  }
});
/** Seeds only the disposable acceptance database; leaves all production admission and projection triggers active. */
export const seedAssessment = Effect.fn(function* ({
  db,
  dataset,
  now,
}: {
  db: D1Database;
  dataset: string;
  now: number;
}) {
  if (
    !(dataset === "small" || dataset === "heavy" || dataset === "extreme" || dataset === "breaking")
  ) {
    throw new Error("Unknown assessment dataset");
  }
  const size = sizes[dataset];
  const start = performance.now();
  yield* seedTransactions(db, size, now);
  yield* seedBudgets(db, size, now);
  yield* seedRecurring(db, size);
  yield* seedReview(db, size, now);
  process.stdout.write(
    `ASSESSMENT_SEED ${json({ dataset, ...size, milliseconds: performance.now() - start })}\n`
  );
});
