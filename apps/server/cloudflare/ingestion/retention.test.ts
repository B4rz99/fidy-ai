import { Data, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  installRetentionTestSchema,
  isolatedTestStorage,
  observeRetentionCost,
} from "../d1-test-fixture";
import { sweepMediaSubmissions } from "./runtime";
import { StatementStaging } from "./internal/statement-staging";

class RetentionTestFailure extends Data.TaggedError("RetentionTestFailure")<{ cause: unknown }> {}
const io = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: run, catch: (cause) => new RetentionTestFailure({ cause }) }).pipe(
    Effect.orDie
  );

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const user = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const now = 50_000_000_000;
const lifetime = 2_592_000_000;
const year = 31_536_000_000;
const prepare = (): Promise<Readonly<{ db: D1Database; bucket: R2Bucket }>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bindings = yield* io(() => storage.acquire());
      yield* io(() => installRetentionTestSchema(bindings.db));
      yield* io(() =>
        bindings.db
          .prepare("INSERT INTO users VALUES (?,'CO','es-CO','UTC',0),(?,'CO','es-CO','UTC',0)")
          .bind(user, other)
          .run()
      );
      return bindings;
    })
  );
const seedMedia = (
  db: D1Database,
  input: Readonly<{
    prefix: string;
    count: number;
    accepted: number;
    content: boolean;
    owner: string;
  }>
): Promise<unknown> =>
  db
    .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO media_submissions SELECT ?||i,?,'p','b',?||i,'digest',?,?,?,?,'CO','es-CO','UTC' FROM n`)
    .bind(
      input.count,
      input.prefix,
      input.owner,
      input.prefix,
      input.content ? "media" : null,
      input.content ? "caption" : null,
      input.accepted,
      input.accepted + lifetime
    )
    .run();
const seedStaging = (
  db: D1Database,
  input: Readonly<{
    prefix: string;
    count: number;
    expires: number;
    state: "available" | "deleting" | "published";
    reclaimed: boolean;
    owner: string;
  }>
): Promise<unknown> =>
  db
    .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO statement_staging_objects
    (id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms,object_deleted_at_ms,published_submission_id)
    SELECT ?||i,?,?||i,1,?, ?,0,?,?,? FROM n`)
    .bind(
      input.count,
      input.prefix,
      input.owner,
      input.prefix,
      "a".repeat(64),
      input.state,
      input.expires,
      input.reclaimed === true ? 1 : null,
      input.state === "published" ? "published" : null
    )
    .run();

it("media idle sweeps seek past cleared 30-day history, future outbox work and the annual archive", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* io(() => prepare());
      yield* io(() =>
        seedMedia(db, {
          owner: user,
          prefix: "cleared-",
          count: 4_000,
          accepted: now - lifetime,
          content: false,
        })
      );
      yield* io(() =>
        seedMedia(db, {
          owner: user,
          prefix: "future-",
          count: 4_000,
          accepted: now,
          content: true,
        })
      );
      yield* io(() =>
        db
          .prepare(
            "INSERT INTO media_submission_outbox SELECT id,user_id,accepted_at_ms FROM media_submissions WHERE media_id IS NOT NULL"
          )
          .run()
      );
      for (let tick = 0; tick < 3; tick += 1) {
        if (tick === 1) yield* io(() => db.prepare("ANALYZE").run());
        const observed = observeRetentionCost(db);
        yield* sweepMediaSubmissions({ db: observed.database, now });
        expect(observed.cost().rowsRead).toBeLessThanOrEqual(20);
        expect(observed.cost().rowsWritten).toBe(0);
        const plans = yield* io(() => observed.plans());
        for (const index of [
          "media_content_retention",
          "media_accountability_retention",
          "media_outbox_retention",
        ]) {
          expect(plans.some((plan) => plan.includes("SEARCH") && plan.includes(index))).toBe(true);
        }
      }
    })
  ));

it("media retention drains fixed-size batches at the exact content and accountability boundaries", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* io(() => prepare());
      yield* io(() =>
        seedMedia(db, {
          owner: user,
          prefix: "content-",
          count: 700,
          accepted: now - lifetime,
          content: true,
        })
      );
      yield* io(() =>
        seedMedia(db, {
          owner: user,
          prefix: "archive-",
          count: 700,
          accepted: now - year,
          content: false,
        })
      );
      yield* io(() =>
        seedMedia(db, {
          prefix: "foreign-live-",
          count: 1,
          accepted: now,
          content: true,
          owner: other,
        })
      );
      yield* io(() =>
        db
          .prepare(
            "INSERT INTO media_submission_outbox SELECT id,user_id,accepted_at_ms FROM media_submissions WHERE media_id IS NOT NULL"
          )
          .run()
      );
      yield* sweepMediaSubmissions({ db, now: now - 1 });
      expect(
        yield* io(() =>
          db.prepare("SELECT count(*) AS count FROM media_submissions").first("count")
        )
      ).toBe(1_401);
      for (let tick = 0; tick < 2; tick += 1) {
        const observed = observeRetentionCost(db);
        yield* sweepMediaSubmissions({ db: observed.database, now });
        expect(observed.cost().rowsRead).toBeLessThanOrEqual(20_000);
        expect(observed.cost().rowsWritten).toBeLessThanOrEqual(10_000);
        expect(
          yield* io(() =>
            db
              .prepare("SELECT count(*) AS count FROM media_submissions WHERE media_id IS NOT NULL")
              .first("count")
          )
        ).toBe(Math.max(0, 700 - 512 * (tick + 1)) + 1);
      }
      expect(
        yield* io(() =>
          db.prepare("SELECT count(*) AS count FROM media_submissions").first("count")
        )
      ).toBe(701);
      expect(
        yield* io(() => db.prepare("SELECT user_id FROM media_submission_outbox").first("user_id"))
      ).toBe(other);
      const repeated = observeRetentionCost(db);
      yield* sweepMediaSubmissions({ db: repeated.database, now });
      expect(repeated.cost().rowsWritten).toBe(0);
      expect(repeated.cost().rowsRead).toBeLessThanOrEqual(20);
    })
  ));

it("staging idle sweeps exclude reclaimed tombstones and seek past unpublished future objects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* io(() => prepare());
      yield* io(() =>
        seedStaging(db, {
          owner: user,
          prefix: "cleared-",
          count: 4_000,
          state: "deleting",
          expires: 1,
          reclaimed: true,
        })
      );
      yield* io(() =>
        seedStaging(db, {
          owner: user,
          reclaimed: false,
          prefix: "future-",
          count: 4_000,
          state: "available",
          expires: now + 1,
        })
      );
      yield* io(() =>
        seedStaging(db, {
          owner: user,
          reclaimed: false,
          prefix: "published-",
          count: 4_000,
          state: "published",
          expires: 1,
        })
      );
      for (let tick = 0; tick < 3; tick += 1) {
        if (tick === 1) yield* io(() => db.prepare("ANALYZE").run());
        const observed = observeRetentionCost(db);
        const staging = StatementStaging.make({
          database: observed.database,
          bucket,
          nowEpochMs: () => now,
        });
        expect(yield* staging.sweepExpiredStatementStaging).toEqual({
          objectsDeleted: 0,
          rowsDeleted: 0,
        });
        expect(observed.cost().rowsRead).toBeLessThanOrEqual(20);
        expect(observed.cost().rowsWritten).toBe(0);
        const plans = yield* io(() => observed.plans());
        expect(plans.some((plan) => plan.includes("statement_staging_delete_retention"))).toBe(
          true
        );
        expect(plans.some((plan) => plan.includes("statement_staging_unpublished_retention"))).toBe(
          true
        );
      }
    })
  ));

it("staging reclaims only bounded due objects, resumes deleting objects and retains referenced deletion evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* io(() => prepare());
      yield* io(() =>
        seedStaging(db, {
          owner: user,
          reclaimed: false,
          prefix: "due-",
          count: 300,
          state: "available",
          expires: now,
        })
      );
      yield* io(() =>
        seedStaging(db, {
          owner: user,
          reclaimed: false,
          prefix: "retry-",
          count: 1,
          state: "deleting",
          expires: now + 1,
        })
      );
      yield* io(() =>
        seedStaging(db, {
          reclaimed: false,
          prefix: "foreign-live-",
          count: 1,
          state: "available",
          expires: now + 1,
          owner: other,
        })
      );
      yield* io(() => bucket.put("due-1", "expired"));
      yield* io(() => bucket.put("retry-1", "discarded"));
      yield* io(() => bucket.put("foreign-live-1", "retained"));
      yield* io(() =>
        db
          .prepare(`INSERT INTO statement_submissions
    (id,user_id,idempotency_key,staging_id,source_format,parser_revision,service_market,locale,time_zone,status,submitted_at_ms,started_at_ms,completed_at_ms,retention_expires_at_ms,input_rows,accepted_rows,needs_review_rows)
    VALUES ('submission',?,'00000000-0000-4000-8000-000000000003','due-1','csv','v1','CO','es-CO','UTC','completed',1,1,1,2,0,0,0)`)
          .bind(user)
          .run()
      );
      for (let tick = 0; tick < 3; tick += 1) {
        if (tick === 1) yield* io(() => db.prepare("ANALYZE").run());
        const observed = observeRetentionCost(db);
        const staging = StatementStaging.make({
          database: observed.database,
          bucket,
          nowEpochMs: () => now,
        });
        const result = yield* staging.sweepExpiredStatementStaging;
        expect(result.objectsDeleted).toBe([200, 101, 0][tick]);
        expect(observed.cost().rowsRead).toBeLessThanOrEqual(4_000);
        expect(observed.cost().rowsWritten).toBeLessThanOrEqual(2_000);
      }
      expect(yield* io(() => bucket.get("due-1"))).toBeNull();
      expect(yield* io(() => bucket.get("retry-1"))).toBeNull();
      expect(yield* io(() => bucket.head("foreign-live-1"))).not.toBeNull();
      expect(
        yield* io(() =>
          db
            .prepare(
              "SELECT status,object_deleted_at_ms FROM statement_staging_objects WHERE id='due-1'"
            )
            .first()
        )
      ).toEqual({ status: "deleting", object_deleted_at_ms: now });
      const repeated = observeRetentionCost(db);
      yield* StatementStaging.make({ database: repeated.database, bucket, nowEpochMs: () => now })
        .sweepExpiredStatementStaging;
      expect(repeated.cost().rowsWritten).toBe(0);
      expect(repeated.cost().rowsRead).toBeLessThanOrEqual(20);
    })
  ));

it("submission expiry commits a complete 200-row page within D1's bind limit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* io(() => prepare());
      yield* io(() =>
        seedStaging(db, {
          owner: user,
          reclaimed: false,
          prefix: "submission-",
          count: 300,
          state: "published",
          expires: now,
        })
      );
      yield* io(() =>
        db
          .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<300)
    INSERT INTO statement_submissions
    (id,user_id,idempotency_key,staging_id,source_format,parser_revision,service_market,locale,time_zone,status,submitted_at_ms,retention_expires_at_ms)
    SELECT 'submission-'||i,?,printf('%036d',i),'submission-'||i,'csv','v1','CO','es-CO','UTC','queued',1,? FROM n`)
          .bind(user, now)
          .run()
      );
      const staging = StatementStaging.make({ database: db, bucket, nowEpochMs: () => now });
      expect(yield* staging.expireStatementSubmissions).toEqual({
        submissionsFailed: 200,
      });
      expect(
        yield* io(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM statement_staging_objects WHERE status='deleting'"
            )
            .first("count")
        )
      ).toBe(200);
      expect(
        yield* io(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM statement_submissions WHERE status='failed' AND failure_reason='retention-expired'"
            )
            .first("count")
        )
      ).toBe(200);
    })
  ));
