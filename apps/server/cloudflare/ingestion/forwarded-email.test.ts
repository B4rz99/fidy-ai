import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import { Clock, Data, Effect, Option } from "effect";
import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import emailWorker from "./email-worker";
import { processForwardedEmail } from "./forwarded-email-processing";
import { receiveForwardedEmailWork } from "./forwarded-email-delivery";
import { UserTransactionCoordinator } from "../transactions/transaction-coordinator";
import { listNeedsReviewItems } from "./statement-review";

const userA = "10000000-0000-4000-8000-000000000101";
const userB = "10000000-0000-4000-8000-000000000102";
const localA = "a".repeat(32);
const localB = "b".repeat(32);
const raw = new TextEncoder().encode(
  "From: bank@example.test\r\nTo: other@example.test\r\nSubject: Compra\r\n\r\nPago confirmado"
);
const instances: Miniflare[] = [];
class TestFailure extends Data.TaggedError("TestFailure")<{ readonly cause: unknown }> {}
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TestFailure({ cause }) }).pipe(Effect.orDie);

const setup = Effect.fn(function* () {
  const miniflare = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "forwarded-email-test", type: "d1" }, EMAIL_BUCKET: { type: "r2" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default { fetch() { return new Response('ok') } }",
                type: "esm",
              },
            },
          },
          name: "forwarded-email-test-worker",
          type: "worker",
        },
      },
    ],
  });
  instances.push(miniflare);
  yield* wait(() => miniflare.ready);
  const bindings = yield* wait(() =>
    miniflare.getBindings<{ DB: D1Database; EMAIL_BUCKET: R2Bucket }>("forwarded-email-test-worker")
  );
  const { DB: db, EMAIL_BUCKET: bucket } = bindings;
  yield* wait(() =>
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL DEFAULT 'America/Bogota');
    CREATE TABLE onboarding_consent_records (user_id TEXT PRIMARY KEY, accepted_at_ms INTEGER NOT NULL);
    CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY);
    CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT, token_digest BLOB, revoked_at_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER);
    CREATE TABLE statement_submission_audit (id TEXT PRIMARY KEY, user_id TEXT, operation TEXT, outcome TEXT, occurred_at_ms INTEGER);
    CREATE TABLE transaction_audit (user_id TEXT, occurred_at_ms INTEGER);
    CREATE TABLE pat_audit (user_id TEXT, pat_id TEXT, operation TEXT, occurred_at_ms INTEGER);
    CREATE TABLE category_audit (user_id TEXT, occurred_at_ms INTEGER);
    CREATE TABLE memory_audit (user_id TEXT, occurred_at_ms INTEGER);
    CREATE TABLE categories (id TEXT PRIMARY KEY);
    INSERT INTO categories (id) VALUES ('10000000-0000-4000-8000-000000000016');
    CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT, amount TEXT, currency TEXT, direction TEXT, counterparty TEXT, category_id TEXT, notes TEXT, occurred_at TEXT, created_at TEXT, UNIQUE(user_id, id));
    CREATE TABLE source_attestations (id TEXT PRIMARY KEY, user_id TEXT, transaction_id TEXT, kind TEXT, service_market TEXT, locale TEXT, time_zone TEXT, interpretation_revision TEXT, created_at TEXT, statement_submission_id TEXT, statement_record_number INTEGER, statement_content_hash TEXT, source_format TEXT);
    CREATE TABLE statement_submissions (id TEXT PRIMARY KEY);
    CREATE TABLE consent_user_context (user_id TEXT PRIMARY KEY, time_zone TEXT);
    CREATE TABLE statement_review_audit (id TEXT PRIMARY KEY, user_id TEXT, operation TEXT, outcome TEXT, occurred_at_ms INTEGER);
    CREATE TABLE statement_needs_review (id TEXT PRIMARY KEY, user_id TEXT, submission_id TEXT, record_number INTEGER, reason TEXT, original_evidence TEXT, issues TEXT, status TEXT, evidence_expires_at_ms INTEGER, created_at_ms INTEGER, service_market TEXT, locale TEXT, time_zone TEXT, source_format TEXT, parser_revision TEXT, extractor_revision TEXT);`)
  );
  for (const action of ["UPDATE", "DELETE"]) {
    yield* wait(() =>
      db
        .prepare(`CREATE TRIGGER source_attestation_no_${action.toLowerCase()}
      BEFORE ${action} ON source_attestations BEGIN SELECT RAISE(ABORT, 'attestation_append_only'); END`)
        .run()
    );
  }
  for (const [name, event, table] of [
    ["statement_submission_audit_no_update", "UPDATE", "statement_submission_audit"],
    ["statement_submission_audit_no_delete", "DELETE", "statement_submission_audit"],
    ["statement_audit_daily_budget", "INSERT", "statement_submission_audit"],
    ["transaction_audit_daily_budget", "INSERT", "transaction_audit"],
    ["pat_canonical_daily_budget", "INSERT", "pat_audit"],
    ["category_canonical_daily_budget", "INSERT", "category_audit"],
    ["memory_canonical_daily_budget", "INSERT", "memory_audit"],
  ]) {
    yield* wait(() =>
      db.prepare(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} BEGIN SELECT 1; END`).run()
    );
  }
  // Migration must issue an address to a User whose Consent predates its installation.
  yield* wait(() => db.prepare("INSERT INTO users (id) VALUES (?)").bind(userA).run());
  yield* wait(() =>
    db
      .prepare("INSERT INTO onboarding_consent_records (user_id, accepted_at_ms) VALUES (?, 1)")
      .bind(userA)
      .run()
  );
  const migration = yield* wait(() =>
    Bun.file(new URL("../migrations/0017_forwarded_email.sql", import.meta.url)).text()
  );
  for (const statement of migration
    .replace(/^--.*$/gmu, "")
    .trim()
    .split(/;\s*\n(?=(?:CREATE|ALTER|INSERT|DROP) |$)/u)) {
    if (statement.trim().length > 0) yield* wait(() => db.prepare(statement.trim()).run());
  }
  const processing = yield* wait(() =>
    Bun.file(new URL("../migrations/0018_forwarded_email_processing.sql", import.meta.url)).text()
  );
  for (const statement of processing
    .replace(/^--.*$/gmu, "")
    .trim()
    .split(/;\s*\n(?=(?:CREATE|ALTER|INSERT|DROP) |$)/u)) {
    if (statement.trim().length > 0) yield* wait(() => db.prepare(statement.trim()).run());
  }
  yield* wait(() => db.prepare("INSERT INTO users (id) VALUES (?)").bind(userB).run());
  yield* wait(() =>
    db
      .prepare("INSERT INTO onboarding_consent_records (user_id, accepted_at_ms) VALUES (?, 1)")
      .bind(userB)
      .run()
  );
  for (const [userId, local] of [
    [userA, localA],
    [userB, localB],
  ]) {
    yield* wait(() =>
      db
        .prepare("UPDATE email_forwarding_addresses SET local_part = ? WHERE user_id = ?")
        .bind(local, userId)
        .run()
    );
  }
  const jobs: Array<{ receiptId: string; userId: string }> = [];
  const env = {
    DB: db,
    EMAIL_BUCKET: bucket,
    EMAIL_QUEUE: {
      send: (job: { receiptId: string; userId: string }): Promise<void> => {
        jobs.push(job);
        return Promise.resolve();
      },
    },
  };
  return { env, db, bucket, jobs };
});

const coordinatorFor = (
  db: D1Database,
  bucket: R2Bucket,
  userId: string
): UserTransactionCoordinator =>
  new UserTransactionCoordinator(
    { id: { name: userId } },
    {
      DB: db,
      EMAIL_BUCKET: bucket,
      AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
      HOSTED_AI_MODEL: approvedWorkersAiModel,
    }
  );

const delivery = (
  to = `${localA}@fidyapp.com`,
  bytes = raw
): Readonly<{
  rejected: string[];
  message: {
    from: string;
    to: string;
    rawSize: number;
    raw: ReadableStream<Uint8Array>;
    setReject: (reason: string) => void;
  };
}> => {
  const rejected: string[] = [];
  return {
    rejected,
    message: {
      from: "someone@example.test",
      to,
      rawSize: bytes.byteLength,
      raw: new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      setReject: (reason: string): void => {
        rejected.push(reason);
      },
    },
  };
};

afterEach(() =>
  Effect.runPromise(
    Effect.forEach(instances.splice(0), (instance) => wait(() => instance.dispose()), {
      discard: true,
    })
  )
);

it("rejects an unapproved envelope even when MIME names a known User, without retaining bytes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket, jobs } = yield* setup();
      const input = delivery(`${"z".repeat(32)}@fidyapp.com`);
      yield* wait(() => emailWorker.email(input.message, env));
      expect(input.rejected).toHaveLength(1);
      expect(
        (yield* wait(() => db.prepare("SELECT id FROM forwarded_email_receipts").all())).results
      ).toHaveLength(0);
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
      expect(jobs).toHaveLength(0);
    })
  ));

it("settles a bounded known email into one Transaction and one immutable attestation on replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket, jobs } = yield* setup();
      const html = yield* wait(() =>
        Bun.file(
          new URL(
            "../../src/shell/ingestion/email-interpretation/formats/davibank-card/fixtures/positive.synthetic.html",
            import.meta.url
          )
        ).text()
      );
      yield* wait(() =>
        db.prepare("UPDATE users SET time_zone = 'America/Lima' WHERE id = ?").bind(userA).run()
      );
      const bytes = new TextEncoder().encode(
        `From: bank@example.test\r\nTo: ${localA}@fidyapp.com\r\nSubject: Compra\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`
      );
      yield* wait(() => emailWorker.email(delivery(undefined, bytes).message, env));
      const receipt = yield* wait(() =>
        db
          .prepare("SELECT id FROM forwarded_email_receipts WHERE user_id = ?")
          .bind(userA)
          .first<{ id: string }>()
      );
      expect(receipt).not.toBeNull();
      if (receipt === null) return;
      yield* wait(() => emailWorker.scheduled(undefined, env));
      const coordinator = coordinatorFor(db, bucket, userA);
      let acknowledgements = 0;
      const work = {
        body: jobs[0],
        ack: (): void => {
          acknowledgements += 1;
        },
      };
      const owner = { getByName: (_name: string): Pick<Fetcher, "fetch"> => coordinator };
      yield* wait(() => receiveForwardedEmailWork([work], owner));
      yield* wait(() => receiveForwardedEmailWork([work], owner));
      expect(acknowledgements).toBe(2);
      const transactions = yield* wait(() =>
        db.prepare("SELECT id, amount FROM transactions WHERE user_id = ?").bind(userA).all()
      );
      expect(transactions.results).toHaveLength(1);
      expect(transactions.results[0]).toMatchObject({ amount: "12500" });
      const attestations = yield* wait(() =>
        db
          .prepare("SELECT kind, time_zone FROM source_attestations WHERE user_id = ?")
          .bind(userA)
          .all()
      );
      expect(attestations.results).toEqual([
        expect.objectContaining({ kind: "notification-email", time_zone: "America/Lima" }),
      ]);
      const sample = yield* wait(() =>
        db.prepare("SELECT structure FROM anonymized_email_samples").first<{ structure: string }>()
      );
      expect(sample).not.toBeNull();
      expect(sample?.structure).not.toContain("12500");
      expect(sample?.structure).not.toContain("bank@example.test");
    })
  ));

it("offers only decoded User and receipt identities to private coordination", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, jobs } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      yield* wait(() => emailWorker.scheduled(undefined, env));
      const seen: string[] = [];
      let acked = false;
      yield* wait(() =>
        receiveForwardedEmailWork(
          [
            {
              body: jobs[0],
              ack: (): void => {
                acked = true;
              },
            },
          ],
          {
            getByName: (name) => ({
              fetch: (request): Promise<Response> => {
                seen.push(name, new URL(new Request(request).url).pathname);
                return Promise.resolve(new Response(null, { status: 200 }));
              },
            }),
          }
        )
      );
      expect(acked).toBe(true);
      expect(seen).toEqual([userA, "/forwarded-email-work"]);
      let retryAcked = false;
      yield* Effect.exit(
        Effect.tryPromise(() =>
          receiveForwardedEmailWork(
            [
              {
                body: jobs[0],
                ack: (): void => {
                  retryAcked = true;
                },
              },
            ],
            {
              getByName: () => ({
                fetch: (): Promise<Response> =>
                  Promise.resolve(new Response(null, { status: 503 })),
              }),
            }
          )
        )
      );
      expect(retryAcked).toBe(false);
      yield* wait(() =>
        receiveForwardedEmailWork(
          [
            {
              body: jobs[0],
              ack: (): void => {
                retryAcked = true;
              },
            },
          ],
          {
            getByName: () => ({
              fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 200 })),
            }),
          }
        )
      );
      expect(retryAcked).toBe(true);
    })
  ));

it("keeps uncertain mail in visible review rather than creating a Transaction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      const receipt = yield* wait(() =>
        db
          .prepare("SELECT id FROM forwarded_email_receipts WHERE user_id = ?")
          .bind(userA)
          .first<{ id: string }>()
      );
      if (receipt === null) throw new Error("Expected receipt");
      yield* wait(() =>
        processForwardedEmail({
          DB: db,
          EMAIL_BUCKET: { get: (key) => bucket.get(key, {}).then(Option.fromNullishOr) },
          userId: userA,
          receiptId: receipt.id,
        })
      );
      const review = yield* wait(() =>
        db
          .prepare("SELECT reason FROM forwarded_email_needs_review WHERE user_id = ?")
          .bind(userA)
          .all()
      );
      expect(review.results).toEqual([expect.objectContaining({ reason: "unsupported-content" })]);
      expect(
        (yield* wait(() => db.prepare("SELECT id FROM transactions").all())).results
      ).toHaveLength(0);
    })
  ));

it("shows only the owner's pending forwarded email in the canonical review page", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      const receipt = yield* wait(() =>
        db
          .prepare("SELECT id FROM forwarded_email_receipts WHERE user_id = ?")
          .bind(userA)
          .first<{ id: string }>()
      );
      if (receipt === null) throw new Error("Expected receipt");
      yield* wait(() =>
        processForwardedEmail({
          DB: db,
          EMAIL_BUCKET: { get: (key) => bucket.get(key, {}).then(Option.fromNullishOr) },
          userId: userA,
          receiptId: receipt.id,
        })
      );
      const digest = new Uint8Array(32);
      const current = yield* Clock.currentTimeMillis;
      for (const [userId, id] of [
        [userA, "10000000-0000-4000-8000-000000000201"],
        [userB, "10000000-0000-4000-8000-000000000202"],
      ]) {
        yield* wait(() =>
          db
            .prepare(`INSERT INTO web_sessions
          (id, user_id, token_digest, idle_expires_at_ms, hard_expires_at_ms)
          VALUES (?, ?, ?, ?, ?)`)
            .bind(id, userId, digest, current + 60_000, current + 60_000)
            .run()
        );
      }
      const page = (id: string, userId: string): Effect.Effect<Response> =>
        listNeedsReviewItems({
          database: db,
          environment: { DB: db },
          subject: { id, userId, digest },
          url: new URL("https://api.fidyapp.com/ingestion/needs-review"),
        });
      const own = yield* page("10000000-0000-4000-8000-000000000201", userA);
      expect(own.status).toBe(200);
      const ownBody: unknown = yield* wait(() => own.json());
      expect(ownBody).toMatchObject({
        data: [{ reason: "unsupported-content", sourceChannel: "forwarded-email" }],
      });
      const other = yield* page("10000000-0000-4000-8000-000000000202", userB);
      const otherBody: unknown = yield* wait(() => other.json());
      expect(otherBody).toMatchObject({ data: [] });
    })
  ));

it("refuses finalization after Consent revocation without partial financial writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      const receipt = yield* wait(() =>
        db
          .prepare("SELECT id FROM forwarded_email_receipts WHERE user_id = ?")
          .bind(userA)
          .first<{ id: string }>()
      );
      if (receipt === null) throw new Error("Expected receipt");
      yield* wait(() =>
        db.prepare("INSERT INTO consent_user_revocations (user_id) VALUES (?)").bind(userA).run()
      );
      yield* wait(() =>
        processForwardedEmail({
          DB: db,
          EMAIL_BUCKET: { get: (key) => bucket.get(key, {}).then(Option.fromNullishOr) },
          userId: userA,
          receiptId: receipt.id,
        })
      );
      expect(
        (yield* wait(() => db.prepare("SELECT receipt_id FROM forwarded_email_outcomes").all()))
          .results
      ).toHaveLength(0);
      expect(
        (yield* wait(() => db.prepare("SELECT id FROM forwarded_email_needs_review").all())).results
      ).toHaveLength(0);
      yield* wait(() => emailWorker.scheduled(undefined, env));
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
      const review = yield* wait(() =>
        db
          .prepare("SELECT reason FROM forwarded_email_needs_review WHERE user_id = ?")
          .bind(userA)
          .first<{ reason: string }>()
      );
      expect(review?.reason).toBe("consent-revoked");
      expect(
        (yield* wait(() => db.prepare("SELECT receipt_id FROM forwarded_email_outcomes").all()))
          .results
      ).toHaveLength(1);
      const current = yield* Clock.currentTimeMillis;
      const session = "10000000-0000-4000-8000-000000000203";
      const digest = new Uint8Array(32);
      yield* wait(() =>
        db
          .prepare(`INSERT INTO web_sessions
        (id, user_id, token_digest, idle_expires_at_ms, hard_expires_at_ms)
        VALUES (?, ?, ?, ?, ?)`)
          .bind(session, userA, digest, current + 60_000, current + 60_000)
          .run()
      );
      const page = yield* listNeedsReviewItems({
        database: db,
        environment: { DB: db },
        subject: { id: session, userId: userA, digest },
        url: new URL("https://api.fidyapp.com/ingestion/needs-review"),
      });
      // Ordinary canonical work remains blocked after revocation; the review is durably
      // recorded for a future authenticated re-consent/data-rights read.
      expect(page.status).toBe(401);
    })
  ));

it("does not let another User's receipt identity authorize reading or finalizing their mail", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      const receipt = yield* wait(() =>
        db
          .prepare("SELECT id FROM forwarded_email_receipts WHERE user_id = ?")
          .bind(userA)
          .first<{ id: string }>()
      );
      if (receipt === null) throw new Error("Expected receipt");
      const coordinator = coordinatorFor(db, bucket, userB);
      let acked = false;
      yield* wait(() =>
        receiveForwardedEmailWork(
          [
            {
              body: { receiptId: receipt.id, userId: userB },
              ack: (): void => {
                acked = true;
              },
            },
          ],
          { getByName: (): Pick<Fetcher, "fetch"> => coordinator }
        )
      );
      expect(acked).toBe(true);
      expect(
        (yield* wait(() => db.prepare("SELECT receipt_id FROM forwarded_email_outcomes").all()))
          .results
      ).toHaveLength(0);
    })
  ));

it("reserves one receipt and private object on replay and publishes only bounded identities", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket, jobs } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      yield* wait(() => emailWorker.email(delivery().message, env));
      const receipts = yield* wait(() =>
        db.prepare("SELECT id, user_id, state FROM forwarded_email_receipts").all<{
          id: string;
          user_id: string;
          state: string;
        }>()
      );
      expect(receipts.results).toHaveLength(1);
      expect(receipts.results[0]?.state).toBe("queued");
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(1);
      yield* wait(() => emailWorker.scheduled(undefined, env));
      expect(jobs).toEqual([{ receiptId: receipts.results[0]?.id, userId: userA }]);
    })
  ));

it("keeps identical mail for two approved Users separate", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      yield* wait(() => emailWorker.email(delivery(`${localB}@fidyapp.com`).message, env));
      expect(
        (yield* wait(() => db.prepare("SELECT id FROM forwarded_email_receipts").all())).results
      ).toHaveLength(2);
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(2);
    })
  ));

it("rejects revoked Consent without reading or retaining a User's email", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket, jobs } = yield* setup();
      yield* wait(() =>
        db.prepare("INSERT INTO consent_user_revocations (user_id) VALUES (?)").bind(userA).run()
      );
      const input = delivery();
      yield* wait(() => emailWorker.email(input.message, env));
      expect(input.rejected).toHaveLength(1);
      expect(
        (yield* wait(() => db.prepare("SELECT id FROM forwarded_email_receipts").all())).results
      ).toHaveLength(0);
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
      expect(jobs).toHaveLength(0);
    })
  ));

it("does not dispatch queued identity after Consent is revoked", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, jobs } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      yield* wait(() =>
        db.prepare("INSERT INTO consent_user_revocations (user_id) VALUES (?)").bind(userA).run()
      );
      yield* wait(() => emailWorker.scheduled(undefined, env));
      expect(jobs).toHaveLength(0);
    })
  ));

it("refuses publication when Consent is revoked after reservation and cleans private bytes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket, jobs } = yield* setup();
      const input = delivery();
      const revokingEnv = {
        ...env,
        EMAIL_BUCKET: {
          put: (
            key: string,
            bytes: Uint8Array,
            options: { customMetadata: { purpose: string } }
          ): Promise<void> =>
            bucket
              .put(key, bytes, options)
              .then(() =>
                db
                  .prepare("INSERT INTO consent_user_revocations (user_id) VALUES (?)")
                  .bind(userA)
                  .run()
              )
              .then(() => undefined),
          delete: (key: string): Promise<void> => bucket.delete(key),
        },
      };
      yield* Effect.exit(Effect.tryPromise(() => emailWorker.email(input.message, revokingEnv)));
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
      expect(
        (yield* wait(() => db.prepare("SELECT id FROM forwarded_email_receipts").all())).results
      ).toHaveLength(0);
      expect(
        (yield* wait(() => db.prepare("SELECT receipt_id FROM forwarded_email_outbox").all()))
          .results
      ).toHaveLength(0);
      expect(jobs).toHaveLength(0);
    })
  ));

it("refuses per-User outstanding capacity before storing another object", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      const now = yield* Clock.currentTimeMillis;
      // This is platform capacity evidence: populate the real D1 authority up to the policy bound.
      for (let index = 0; index < 100; index++) {
        yield* wait(() =>
          db
            .prepare(
              `INSERT INTO forwarded_email_receipts
           (id, user_id, delivery_digest, object_key, byte_length, state, received_at_ms, expires_at_ms)
           VALUES (?, ?, ?, ?, 1, 'queued', ?, ?)`
            )
            .bind(
              `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
              userA,
              index.toString().padStart(64, "0"),
              `test/${index}`,
              now,
              now + 60_000
            )
            .run()
        );
      }
      const input = delivery();
      yield* wait(() => emailWorker.email(input.message, env));
      expect(input.rejected).toHaveLength(1);
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
      expect(
        (yield* wait(() => db.prepare("SELECT id FROM forwarded_email_receipts").all())).results
      ).toHaveLength(100);
    })
  ));

it("enforces the global outstanding cap atomically across Users", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      const now = yield* Clock.currentTimeMillis;
      for (let index = 1; index < 10; index++) {
        yield* wait(() =>
          db.prepare("INSERT INTO users (id) VALUES (?)").bind(`fidy-test-${index}`).run()
        );
        yield* wait(() =>
          db
            .prepare("INSERT INTO onboarding_consent_records VALUES (?, 1)")
            .bind(`fidy-test-${index}`)
            .run()
        );
      }
      yield* wait(() =>
        db
          .prepare(`
        WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM numbers WHERE n < 999)
        INSERT INTO forwarded_email_receipts
          (id, user_id, delivery_digest, object_key, byte_length, state, received_at_ms, expires_at_ms)
        SELECT printf('00000000-0000-4000-8000-%012d', n),
          CASE WHEN n < 100 THEN ? ELSE printf('fidy-test-%d', CAST(n / 100 AS INTEGER)) END,
          printf('%064d', n), printf('test/%d', n), 1, 'queued', ?, ? FROM numbers
      `)
          .bind(userA, now, now + 60_000)
          .run()
      );
      const input = delivery();
      yield* wait(() => emailWorker.email(input.message, env));
      expect(input.rejected).toHaveLength(1);
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
      const total = yield* wait(() =>
        db
          .prepare("SELECT count(*) AS count FROM forwarded_email_receipts")
          .first<{ count: number }>()
      );
      expect(total?.count).toBe(1000);
    })
  ));

it("bounds retained email arrivals even after processing frees outstanding capacity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      const now = yield* Clock.currentTimeMillis;
      yield* wait(() =>
        db
          .prepare(`WITH RECURSIVE numbers(n) AS
        (SELECT 0 UNION ALL SELECT n + 1 FROM numbers WHERE n < 999)
        INSERT INTO forwarded_email_receipts
        (id, user_id, delivery_digest, object_key, byte_length, state, received_at_ms, expires_at_ms)
        SELECT printf('00000000-0000-4000-8000-%012d', n), ?,
          printf('%064d', n), printf('email/v1/%036d', n), 1, 'expired', ?, ?
        FROM numbers`)
          .bind(userA, now, now + 60_000)
          .run()
      );
      const input = delivery();
      yield* wait(() => emailWorker.email(input.message, env));
      expect(input.rejected).toHaveLength(1);
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
    })
  ));

it("does not permanently reject transient stream failure as malformed email", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      const input = delivery();
      input.message.raw = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.error(new Error("temporary transport failure"));
        },
      });
      yield* Effect.exit(Effect.tryPromise(() => emailWorker.email(input.message, env)));
      expect(input.rejected).toHaveLength(0);
      expect(
        (yield* wait(() => db.prepare("SELECT id FROM forwarded_email_receipts").all())).results
      ).toHaveLength(0);
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
    })
  ));

it("deletes expired private email while keeping a replay tombstone", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket, jobs } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      const row = yield* wait(() =>
        db
          .prepare("SELECT id, object_key FROM forwarded_email_receipts WHERE user_id = ?")
          .bind(userA)
          .first<{ id: string; object_key: string }>()
      );
      expect(row).not.toBeNull();
      yield* wait(() =>
        db
          .prepare(
            "UPDATE forwarded_email_receipts SET received_at_ms = 0, expires_at_ms = 1 WHERE user_id = ?"
          )
          .bind(userA)
          .run()
      );
      yield* wait(() => emailWorker.scheduled(undefined, env));
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
      expect(
        (yield* wait(() =>
          db
            .prepare("SELECT state FROM forwarded_email_receipts WHERE user_id = ?")
            .bind(userA)
            .first<{ state: string }>()
        ))?.state
      ).toBe("expired");
      expect(jobs).toHaveLength(0);
      const review = yield* wait(() =>
        db
          .prepare("SELECT reason FROM forwarded_email_needs_review WHERE user_id = ?")
          .bind(userA)
          .first<{ reason: string }>()
      );
      expect(review?.reason).toBe("processing-interrupted");
      yield* wait(() => emailWorker.email(delivery().message, env));
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
    })
  ));

it("clears near-expiry email before the bounded sweep can exceed its retention deadline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      const deadline = (yield* Clock.currentTimeMillis) + 3_600_000;
      yield* wait(() =>
        db
          .prepare("UPDATE forwarded_email_receipts SET expires_at_ms = ? WHERE user_id = ?")
          .bind(deadline, userA)
          .run()
      );
      yield* wait(() => emailWorker.scheduled(undefined, env));
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
      const review = yield* wait(() =>
        db
          .prepare(
            "SELECT reason, evidence_expires_at_ms FROM forwarded_email_needs_review WHERE user_id = ?"
          )
          .bind(userA)
          .first<{ reason: string; evidence_expires_at_ms: number }>()
      );
      expect(review?.reason).toBe("processing-interrupted");
      expect(review?.evidence_expires_at_ms).toBeLessThan(deadline);
    })
  ));

it("records interrupted reservations visibly before expiring their private bytes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      const id = "00000000-0000-4000-8000-000000000912";
      const key = `email/v1/${id}`;
      yield* wait(() =>
        db
          .prepare(`INSERT INTO forwarded_email_receipts
        (id, user_id, delivery_digest, object_key, byte_length, state, received_at_ms, expires_at_ms)
        VALUES (?, ?, ?, ?, 1, 'storing', 0, 1)`)
          .bind(id, userA, "9".repeat(64), key)
          .run()
      );
      yield* wait(() => bucket.put(key, new Uint8Array([1])));
      yield* wait(() => emailWorker.scheduled(undefined, env));
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
      const review = yield* wait(() =>
        db
          .prepare("SELECT reason FROM forwarded_email_needs_review WHERE receipt_id = ?")
          .bind(id)
          .first<{ reason: string }>()
      );
      expect(review?.reason).toBe("processing-interrupted");
      const receipt = yield* wait(() =>
        db
          .prepare("SELECT state FROM forwarded_email_receipts WHERE id = ?")
          .bind(id)
          .first<{ state: string }>()
      );
      expect(receipt?.state).toBe("expired");
    })
  ));

it("makes an interrupted reservation visible after its bounded write window", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      const id = "00000000-0000-4000-8000-000000000913";
      const key = `email/v1/${id}`;
      const current = yield* Clock.currentTimeMillis;
      yield* wait(() =>
        db
          .prepare(`INSERT INTO forwarded_email_receipts
        (id, user_id, delivery_digest, object_key, byte_length, state, received_at_ms, expires_at_ms)
        VALUES (?, ?, ?, ?, 1, 'storing', ?, ?)`)
          .bind(id, userA, "8".repeat(64), key, current - 900_001, current + 60_000_000)
          .run()
      );
      yield* wait(() => bucket.put(key, new Uint8Array([1])));
      yield* wait(() => emailWorker.scheduled(undefined, env));
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
      const review = yield* wait(() =>
        db
          .prepare("SELECT reason FROM forwarded_email_needs_review WHERE receipt_id = ?")
          .bind(id)
          .first<{ reason: string }>()
      );
      expect(review?.reason).toBe("processing-interrupted");
    })
  ));

it("does not sweep an interrupted R2 write before the hard retention deadline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      const now = yield* Clock.currentTimeMillis;
      const key = "email/v1/00000000-0000-4000-8000-000000000911";
      yield* wait(() =>
        db
          .prepare(`INSERT INTO forwarded_email_receipts
      (id, user_id, delivery_digest, object_key, byte_length, state, received_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?, 1, 'storing', ?, ?)`)
          .bind(
            "00000000-0000-4000-8000-000000000911",
            userA,
            "9".repeat(64),
            key,
            now - 60_000,
            now + 60_000_000
          )
          .run()
      );
      yield* wait(() => bucket.put(key, new Uint8Array([1])));
      yield* wait(() => emailWorker.scheduled(undefined, env));
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(1);
      expect(
        (yield* wait(() =>
          db
            .prepare("SELECT state FROM forwarded_email_receipts WHERE object_key = ?")
            .bind(key)
            .first<{ state: string }>()
        ))?.state
      ).toBe("storing");
    })
  ));

it("keeps retention failure visible and retries private deletion without duplicating review", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      yield* wait(() =>
        db
          .prepare(
            "UPDATE forwarded_email_receipts SET received_at_ms = 0, expires_at_ms = 1 WHERE user_id = ?"
          )
          .bind(userA)
          .run()
      );
      const unavailableBucket = {
        ...bucket,
        put: (
          key: string,
          bytes: Uint8Array,
          options: { customMetadata: { purpose: string } }
        ): Promise<unknown> => bucket.put(key, bytes, options),
        delete: (_key: string): Promise<never> => Promise.reject(new Error("R2 unavailable")),
      };
      yield* Effect.exit(
        Effect.tryPromise(() =>
          emailWorker.scheduled(undefined, {
            ...env,
            EMAIL_BUCKET: unavailableBucket,
          })
        )
      );
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(1);
      const review = yield* wait(() =>
        db
          .prepare("SELECT reason FROM forwarded_email_needs_review WHERE user_id = ?")
          .bind(userA)
          .first<{ reason: string }>()
      );
      expect(review?.reason).toBe("processing-interrupted");
      yield* wait(() => emailWorker.scheduled(undefined, env));
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
      const reviews = yield* wait(() =>
        db
          .prepare("SELECT id FROM forwarded_email_needs_review WHERE user_id = ?")
          .bind(userA)
          .all()
      );
      expect(reviews.results).toHaveLength(1);
    })
  ));

it("does not delete an arbitrary R2 object from a malformed D1 sweep projection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      yield* wait(() => emailWorker.email(delivery().message, env));
      yield* wait(() =>
        db
          .prepare(
            "UPDATE forwarded_email_receipts SET object_key = 'other-purpose/private', received_at_ms = 0, expires_at_ms = 1 WHERE user_id = ?"
          )
          .bind(userA)
          .run()
      );
      yield* Effect.exit(Effect.tryPromise(() => emailWorker.scheduled(undefined, env)));
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(1);
    })
  ));

it("refuses attachments and dishonest length before any authoritative receipt or R2 object", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { env, db, bucket } = yield* setup();
      const attachment = new TextEncoder().encode(
        "MIME-Version: 1.0\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=evil.pdf\r\n\r\nfile"
      );
      const first = delivery(`${localA}@fidyapp.com`, attachment);
      yield* wait(() => emailWorker.email(first.message, env));
      expect(first.rejected).toHaveLength(1);
      const second = delivery();
      second.message.rawSize = 1;
      yield* wait(() => emailWorker.email(second.message, env));
      expect(second.rejected).toHaveLength(1);
      expect(
        (yield* wait(() => db.prepare("SELECT id FROM forwarded_email_receipts").all())).results
      ).toHaveLength(0);
      expect((yield* wait(() => bucket.list())).objects).toHaveLength(0);
    })
  ));
