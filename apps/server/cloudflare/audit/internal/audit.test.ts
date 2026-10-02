import { afterAll, expect, it } from "vitest";
import { Data, DateTime, Effect } from "effect";
import { recordAuthorizedCall, recordOwnerCall } from "../../../src/shell/audit/operations";
import { makeAudit, makeAuditRetention } from "../../../src/shell/audit/runtime";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import { installTestSchema, isolatedTestDatabases } from "../../d1-test-fixture";
import coreWorker from "../../core-worker";
import { approvedWorkersAiModel } from "../../../src/shell/hosted-inference/contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const sessionId = "20000000-0000-4000-8000-000000000001";
const otherSessionId = "20000000-0000-4000-8000-000000000002";
const current = Date.UTC(2026, 8, 30);
const digest = new Uint8Array(32).fill(1);
class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ readonly cause: unknown }> {}
const attempt = <A>(work: () => Promise<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({ try: work, catch: (cause) => new FixtureFailure({ cause }) });

const setup = (): Effect.Effect<D1Database, FixtureFailure> =>
  Effect.gen(function* () {
    const db = yield* attempt(() => databases.acquire());
    const names = Array.from(
      new Bun.Glob("*.sql").scanSync(new URL("../../migrations/", import.meta.url).pathname)
    ).sort();
    yield* attempt(() =>
      installTestSchema({
        db,
        sources: names.map((name) => new URL(`../../migrations/${name}`, import.meta.url)),
      })
    );
    yield* attempt(() =>
      db.batch([
        ...[userId, otherUserId].map((id) =>
          db
            .prepare(
              "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
            )
            .bind(id, current)
        ),
        ...[
          { id: sessionId, user: userId, code: "ABC-DEF12", digest },
          {
            id: otherSessionId,
            user: otherUserId,
            code: "ABC-DEF13",
            digest: new Uint8Array(32).fill(2),
          },
        ].flatMap((session) => [
          db
            .prepare(
              "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
            )
            .bind(
              session.id,
              session.code,
              session.digest,
              session.user,
              current,
              current + 600000
            ),
          db
            .prepare(
              "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(
              session.id,
              session.id,
              session.user,
              session.digest,
              current,
              current + 600000,
              current + 86400000,
              current + 7776000000
            ),
        ]),
      ])
    );
    return db;
  });

it("records only approved canonical-call metadata and never returns another User's evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordAuthorizedCall({
        authority: liveWebSessionAuthority({ subject: { id: sessionId, userId, digest }, current }),
        id: "30000000-0000-4000-8000-000000000001",
        operation: "transactions.listTransactions",
        outcome: "success",
        current,
        afterOwnerWrite: false,
      });
      yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      const audit = makeAudit({ database: db });
      const entries = yield* audit.query({ userId, limit: 10 });
      expect(entries).toEqual([
        {
          id: "30000000-0000-4000-8000-000000000001",
          subjectUserId: userId,
          caller: { _tag: "WebSession", webSessionId: sessionId },
          operation: "transactions.listTransactions",
          outcome: "succeeded",
          occurredAt: DateTime.makeUnsafe(current),
        },
      ]);
      expect(yield* audit.query({ userId: otherUserId, limit: 10 })).toEqual([]);
    })
  ));

it("refuses another User's credential without appending evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordAuthorizedCall({
        authority: liveWebSessionAuthority({
          subject: { id: sessionId, userId: otherUserId, digest },
          current,
        }),
        id: "30000000-0000-4000-8000-000000000002",
        operation: "transactions.listTransactions",
        outcome: "success",
        current,
        afterOwnerWrite: false,
      });
      const result = yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      expect(result.meta.changes).toBe(0);
      const audit = makeAudit({ database: db });
      expect(yield* audit.query({ userId, limit: 10 })).toEqual([]);
      expect(yield* audit.query({ userId: otherUserId, limit: 10 })).toEqual([]);
    })
  ));

it("keeps owner work and required Audit evidence atomic when append-only evidence refuses a duplicate", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordOwnerCall({
        id: "30000000-0000-4000-8000-000000000003",
        userId,
        caller: { _tag: "WebSession", id: sessionId },
        operation: "transactions.createTransaction",
        outcome: "success",
        current,
        when: { sql: "SELECT 1", params: [] },
        afterOwnerWrite: false,
      });
      yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      const result = yield* Effect.result(
        attempt(() =>
          db.batch([
            db.prepare("UPDATE users SET time_zone = 'UTC' WHERE id = ?").bind(userId),
            db.prepare(statement.sql).bind(...statement.params),
          ])
        )
      );
      expect(result._tag).toBe("Failure");
      expect(
        yield* attempt(() =>
          db.prepare("SELECT time_zone FROM users WHERE id = ?").bind(userId).first("time_zone")
        )
      ).toBe("America/Bogota");
      expect(yield* makeAudit({ database: db }).query({ userId, limit: 10 })).toHaveLength(1);
    })
  ));

it("retains evidence for 365 days, removes only the selected User's older evidence, and keeps ordinary deletion forbidden", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const retentionNow = current + 365 * 86400000;
      const statements = [
        { id: "30000000-0000-4000-8000-000000000004", userId, occurredAt: current - 1 },
        { id: "30000000-0000-4000-8000-000000000005", userId, occurredAt: current },
        {
          id: "30000000-0000-4000-8000-000000000006",
          userId: otherUserId,
          occurredAt: current - 1,
        },
      ].map((entry) =>
        recordOwnerCall({
          id: entry.id,
          userId: entry.userId,
          caller: { _tag: "WebSession", id: entry.userId === userId ? sessionId : otherSessionId },
          operation: "transactions.listTransactions",
          outcome: "success",
          current: entry.occurredAt,
          when: { sql: "SELECT 1", params: [] },
          afterOwnerWrite: false,
        })
      );
      yield* attempt(() =>
        db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)))
      );
      const deletion = yield* Effect.result(
        attempt(() =>
          db.prepare("DELETE FROM transaction_audit WHERE user_id = ?").bind(userId).run()
        )
      );
      expect(deletion._tag).toBe("Failure");
      const rewrite = yield* Effect.result(
        attempt(() =>
          db
            .prepare("UPDATE transaction_audit SET outcome = 'not_found' WHERE user_id = ?")
            .bind(userId)
            .run()
        )
      );
      expect(rewrite._tag).toBe("Failure");
      expect(
        yield* makeAuditRetention({ database: db }).retain({ userId, now: retentionNow })
      ).toBe(1);
      const audit = makeAudit({ database: db });
      expect((yield* audit.query({ userId, limit: 10 })).map((entry) => entry.id)).toEqual([
        "30000000-0000-4000-8000-000000000005",
      ]);
      expect(
        (yield* audit.query({ userId: otherUserId, limit: 10 })).map((entry) => entry.id)
      ).toEqual(["30000000-0000-4000-8000-000000000006"]);
      const afterRetention = yield* Effect.result(
        attempt(() =>
          db.prepare("DELETE FROM transaction_audit WHERE user_id = ?").bind(userId).run()
        )
      );
      expect(afterRetention._tag).toBe("Failure");
    })
  ));

it("rolls retention back and leaves ordinary deletion forbidden when a later projection fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordOwnerCall({
        id: "30000000-0000-4000-8000-000000000007",
        userId,
        caller: { _tag: "WebSession", id: sessionId },
        operation: "transactions.listTransactions",
        outcome: "success",
        current: current - 1,
        when: { sql: "SELECT 1", params: [] },
        afterOwnerWrite: false,
      });
      yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      yield* attempt(() =>
        db
          .prepare(
            "CREATE TRIGGER audit_retention_failure BEFORE DELETE ON audit_retention_permits BEGIN SELECT RAISE(ABORT, 'private database detail'); END"
          )
          .run()
      );
      const result = yield* Effect.result(
        makeAuditRetention({ database: db }).retain({ userId, now: current + 365 * 86400000 })
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toEqual(expect.objectContaining({ _tag: "AuditUnavailable" }));
      }
      expect(yield* makeAudit({ database: db }).query({ userId, limit: 10 })).toHaveLength(1);
      const deletion = yield* Effect.result(
        attempt(() =>
          db.prepare("DELETE FROM transaction_audit WHERE user_id = ?").bind(userId).run()
        )
      );
      expect(deletion._tag).toBe("Failure");
    })
  ));

it("returns a safe failure instead of exposing malformed stored evidence or database details", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* attempt(() =>
        db
          .prepare(
            "INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms) VALUES ('malformed-private-value', ?, ?, 'transactions.listTransactions', 'success', ?)"
          )
          .bind(userId, sessionId, current)
          .run()
      );
      const result = yield* Effect.result(makeAudit({ database: db }).query({ userId, limit: 10 }));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("AuditUnavailable");
        expect(result.failure).not.toHaveProperty("cause");
        expect(String(result.failure)).not.toContain("malformed-private-value");
      }
    })
  ));

it("observes subject-scoped publication evidence without inventing a missing credential", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordAuthorizedCall({
        authority: liveWebSessionAuthority({ subject: { id: sessionId, userId, digest }, current }),
        id: "30000000-0000-4000-8000-000000000008",
        operation: "ingestion.listNeedsReviewItems",
        outcome: "success",
        current,
        afterOwnerWrite: false,
      });
      yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      const audit = makeAudit({ database: db });
      const entries = yield* audit.publications({ userId, limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        id: "30000000-0000-4000-8000-000000000008",
        subjectUserId: userId,
        operation: "ingestion.listNeedsReviewItems",
        outcome: "succeeded",
        occurredAt: DateTime.makeUnsafe(current),
      });
      expect(yield* audit.publications({ userId: otherUserId, limit: 10 })).toEqual([]);
    })
  ));

it("runs scheduled Audit retention independently of a failed earlier maintenance activity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordOwnerCall({
        id: "30000000-0000-4000-8000-000000000009",
        userId,
        caller: { _tag: "WebSession", id: sessionId },
        operation: "transactions.listTransactions",
        outcome: "success",
        current: current - 366 * 86400000,
        when: { sql: "SELECT 1", params: [] },
        afterOwnerWrite: false,
      });
      yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      const result = yield* Effect.result(
        attempt(() =>
          coreWorker.scheduled(
            { cron: "* * * * *", scheduledTime: current, noRetry: () => {} },
            {
              DB: db,
              ASYNC_HEALTH_ENABLED: "enabled",
              AI: { run: () => Promise.reject(new Error("unused model")) },
              USER_TRANSACTION_COORDINATOR: {
                getByName: (): Pick<Fetcher, "fetch"> => ({
                  fetch: () => Promise.reject(new Error("unused coordinator")),
                }),
              },
              CONTRACT_DIGEST: "a".repeat(64),
              RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
              HOSTED_AI_MODEL: approvedWorkersAiModel,
              BROWSER_ORIGIN: "https://app.fidyapp.com",
              WOMPI_ENVIRONMENT: "",
              WOMPI_PUBLIC_KEY: "",
              WOMPI_PRIVATE_KEY: "",
              WOMPI_INTEGRITY_SECRET: "",
              KAPSO_API_KEY: "",
              KAPSO_WEBHOOK_SECRET: "unused",
              WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
              CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
              CLOUDFLARE_ACCESS_AUDIENCE: "test",
            }
          )
        )
      );
      expect(result._tag).toBe("Failure");
      expect(yield* makeAudit({ database: db }).query({ userId, limit: 10 })).toEqual([]);
    })
  ));

it("bounds retention work and resumes the remaining expired evidence on the next run", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statements = Array.from({ length: 65 }, (_, index) =>
        recordOwnerCall({
          id: `30000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
          userId,
          caller: { _tag: "WebSession", id: sessionId },
          operation: "transactions.listTransactions",
          outcome: "success",
          current: current - 1,
          when: { sql: "SELECT 1", params: [] },
          afterOwnerWrite: false,
        })
      );
      yield* attempt(() =>
        db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)))
      );
      const retention = makeAuditRetention({ database: db });
      expect(yield* retention.retain({ userId, now: current + 365 * 86400000 })).toBe(64);
      expect(yield* makeAudit({ database: db }).query({ userId, limit: 256 })).toHaveLength(1);
      expect(yield* retention.retain({ userId, now: current + 365 * 86400000 })).toBe(1);
      expect(yield* makeAudit({ database: db }).query({ userId, limit: 256 })).toEqual([]);
    })
  ));
