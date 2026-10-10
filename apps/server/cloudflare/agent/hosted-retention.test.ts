import { Effect, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  applyTestMigration,
  installTestSchema,
  isolatedTestDatabases,
  observeRetentionCost,
} from "../d1-test-fixture";
import { UserId } from "../../src/core/identity/contract";
import { makeAgentRetention } from "./runtime";
import { expireHostedPending, hostedTranscriptRetentionMs } from "./internal/turn-store";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = UserId.make("10000000-0000-4000-8000-000000000001");
const otherUserId = UserId.make("10000000-0000-4000-8000-000000000002");
const day = 86_400_000;
const now = 200 * day;
const setup = (includeRetention = true): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const directory = new URL("../migrations/", import.meta.url);
      const names = Array.from(new Bun.Glob("*.sql").scanSync(directory.pathname))
        .filter(
          (name) =>
            name.endsWith(".sql") && (includeRetention || name !== "0074_hosted_retention.sql")
        )
        .sort();
      yield* Effect.tryPromise(() =>
        installTestSchema({
          db,
          sources: names.map((name) => new URL(name, directory)),
        })
      );
      yield* Effect.tryPromise(() =>
        db.batch(
          [userId, otherUserId].flatMap((user) => [
            db.prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'UTC', 0)").bind(user),
            db
              .prepare(`INSERT INTO hosted_agent_sessions
        (id,user_id,consent_basis_json,started_at_ms,status) VALUES (?,?,'{}',0,'active')`)
              .bind(user, user),
          ])
        )
      );
      return db;
    })
  );

// Model already-retired history without paying thousands of live admission batches. All
// production triggers are restored before either new evidence or the retention operation runs.
const seedHistory = (db: D1Database): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const triggers = yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
    AND name IN ('hosted_turns_begin_pending','hosted_turn_requires_consent')`)
          .all<{
            name: string;
            sql: string;
          }>()
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          ...triggers.results.map((trigger) => db.prepare(`DROP TRIGGER ${trigger.name}`)),
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000)
      INSERT INTO hosted_turns(id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status)
      SELECT 'retired-'||i, ?, ?, i*86400000/50, i*86400000/50+1, 'completed' FROM n`)
            .bind(userId, userId),
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100)
      INSERT INTO hosted_turns(id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status)
      SELECT 'retained-'||i, ?, ?, 198*86400000+i*86400000/50,
        198*86400000+i*86400000/50+1, 'completed' FROM n`)
            .bind(userId, userId),
          db
            .prepare(`INSERT INTO hosted_turns(id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status)
      VALUES ('other-retired', ?, ?, 0, 1, 'completed')`)
            .bind(otherUserId, otherUserId),
          ...triggers.results.map((trigger) => db.prepare(trigger.sql)),
          db.prepare(`INSERT INTO transcript_entries(id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,text)
      SELECT id,user_id,hosted_session_id,id,'assistant',terminal_at_ms,'retained'
      FROM hosted_turns WHERE id LIKE 'retained-%'`),
        ])
      );
    })
  );
it("keeps repeated idle sweeps independent of permanent terminal history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() => seedHistory(db));
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000)
      INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status)
      SELECT 'compact-'||i,?,'{}',?,'idle-ended' FROM n`)
            .bind(userId, now),
          db
            .prepare(`INSERT INTO hosted_compacted_conversations
      SELECT user_id,id,'retained',0,1,id,? FROM hosted_agent_sessions WHERE id LIKE 'compact-%'`)
            .bind(now),
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000)
      INSERT INTO hosted_compaction_attempts SELECT ?, ?+i*86400000, 1 FROM n`)
            .bind(userId, now),
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000)
      INSERT INTO hosted_confirmations
      (id,user_id,issued_turn_id,operation,input_json,command,issued_at_ms,expires_at_ms)
      SELECT 'confirmation-'||i,?,'retained-1','memory.forget','{}','confirm',?,? FROM n`)
            .bind(userId, now, now + hostedTranscriptRetentionMs),
        ])
      );
      for (let tick = 0; tick < 2; tick += 1) {
        const observed = observeRetentionCost(db);
        yield* makeAgentRetention({ db: observed.database }).sweep(now);
        expect(observed.cost().rowsRead).toBeLessThanOrEqual(50);
        expect(observed.cost().rowsWritten).toBe(0);
      }
      const observed = observeRetentionCost(db);
      const deadline = yield* expireHostedPending({
        db: observed.database,
        userId,
        now,
      });
      expect(deadline).toEqual(Option.some(198 * day + day / 50 + 2 + hostedTranscriptRetentionMs));
      expect(observed.cost().rowsRead).toBeLessThanOrEqual(50);
      expect(observed.cost().rowsWritten).toBe(0);
    })
  ));
it("cleans only the addressed User and retains discovery after a terminal marker is removed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() => seedHistory(db));
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(`INSERT INTO transcript_entries(id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,text)
      SELECT id||'-user',user_id,hosted_session_id,id,'user',started_at_ms,'expired'
      FROM hosted_turns WHERE id IN ('retired-1','other-retired')`),
          db.prepare(`INSERT INTO transcript_entries(id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,text)
      SELECT id||'-assistant',user_id,hosted_session_id,id,'assistant',terminal_at_ms,'expired'
      FROM hosted_turns WHERE id IN ('retired-1','other-retired')`),
          db.prepare(`INSERT INTO hosted_mutation_commits
      SELECT id,'call',user_id,started_at_ms,1 FROM hosted_turns WHERE id IN ('retired-1','other-retired')`),
          db.prepare("DELETE FROM transcript_entries WHERE id = 'retired-1-assistant'"),
        ])
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(`INSERT INTO transcript_entries
    (id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,text)
    VALUES ('cross-owner',?,?,'retired-2','user',1,'wrong owner')`)
            .bind(otherUserId, otherUserId)
            .run()
        ).rejects.toThrow()
      );
      const observed = observeRetentionCost(db);
      yield* expireHostedPending({
        db: observed.database,
        userId,
        now,
      });
      expect(observed.cost().rowsRead).toBeLessThanOrEqual(200);
      expect(observed.cost().rowsWritten).toBeGreaterThan(0);
      expect(observed.cost().rowsWritten).toBeLessThanOrEqual(20);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(`SELECT turn_id FROM transcript_entries
    WHERE turn_id IN ('retired-1','other-retired')`)
            .all()
        )).results
      ).toEqual([
        {
          turn_id: "other-retired",
        },
        {
          turn_id: "other-retired",
        },
      ]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT turn_id FROM hosted_mutation_commits").all()
        )).results
      ).toEqual([
        {
          turn_id: "other-retired",
        },
      ]);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM hosted_turns").first("count")
        )
      ).toBe(4101);
      yield* makeAgentRetention({
        db,
      }).sweep(now);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM transcript_entries").first("count")
        )
      ).toBe(100);
      const idle = observeRetentionCost(db);
      yield* makeAgentRetention({
        db: idle.database,
      }).sweep(now);
      expect(idle.cost().rowsRead).toBeLessThanOrEqual(50);
      expect(idle.cost().rowsWritten).toBe(0);
    })
  ));
it("backfills only retained terminal evidence and drops its deadline with the last entry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup(false));
      yield* Effect.tryPromise(() => seedHistory(db));
      yield* Effect.tryPromise(() =>
        applyTestMigration({
          db,
          source: new URL("../migrations/0074_hosted_retention.sql", import.meta.url),
        })
      );
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM hosted_turn_retention").first("count")
        )
      ).toBe(100);
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO hosted_compacted_conversations
    SELECT user_id,hosted_session_id,'compacted',max(sequence),1,'compaction',?
    FROM transcript_entries GROUP BY user_id,hosted_session_id`)
          .bind(now)
          .run()
      );
      const observed = observeRetentionCost(db);
      yield* Effect.tryPromise(() =>
        observed.database
          .prepare("DELETE FROM transcript_entries WHERE user_id = ?")
          .bind(userId)
          .run()
      );
      expect(observed.cost().rowsRead).toBeLessThanOrEqual(2_000);
      expect(observed.cost().rowsWritten).toBeLessThanOrEqual(1_000);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM hosted_turn_retention").first("count")
        )
      ).toBe(0);
      const idle = observeRetentionCost(db);
      yield* makeAgentRetention({
        db: idle.database,
      }).sweep(now);
      expect(idle.cost().rowsRead).toBeLessThanOrEqual(50);
      expect(idle.cost().rowsWritten).toBe(0);
    })
  ));

it("bounds every due branch before grouping a large retained backlog", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() => seedHistory(db));
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(`INSERT INTO transcript_entries(id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,text)
        SELECT id,user_id,hosted_session_id,id,'assistant',terminal_at_ms,'expired'
        FROM hosted_turns WHERE id LIKE 'retired-%'`),
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000)
        INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status)
        SELECT 'old-compact-'||i,?,'{}',0,'idle-ended' FROM n`)
            .bind(userId),
          db.prepare(`INSERT INTO hosted_compacted_conversations
        SELECT user_id,id,'expired',0,1,id,1 FROM hosted_agent_sessions WHERE id LIKE 'old-compact-%'`),
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000)
        INSERT INTO hosted_compaction_attempts SELECT ?, -i*86400000, 1 FROM n`)
            .bind(userId),
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000)
        INSERT INTO hosted_confirmations
        (id,user_id,issued_turn_id,operation,input_json,command,issued_at_ms,expires_at_ms)
        SELECT 'expired-confirmation-'||i,?,'retired-1','memory.forget','{}','confirm',0,1 FROM n`)
            .bind(userId),
        ])
      );
      for (let tick = 0; tick < 40; tick += 1) {
        const observed = observeRetentionCost(db);
        yield* makeAgentRetention({ db: observed.database }).sweep(now);
        expect(observed.discovery()).toBeLessThanOrEqual(1_000);
        expect(observed.cost().rowsRead).toBeLessThanOrEqual(15_000);
        expect(observed.cost().rowsWritten).toBeLessThanOrEqual(3_000);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS count FROM hosted_confirmations").first("count")
          )
        ).toBe(4_000 - 100 * (tick + 1));
      }
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM transcript_entries").first("count")
        )
      ).toBe(100);
      const idle = observeRetentionCost(db);
      yield* makeAgentRetention({ db: idle.database }).sweep(now);
      expect(idle.cost().rowsRead).toBeLessThanOrEqual(50);
      expect(idle.cost().rowsWritten).toBe(0);
    })
  ));

it("keeps compacted mutation receipts discoverable until their own retention boundary", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() => seedHistory(db));
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("INSERT INTO hosted_mutation_commits VALUES ('retained-1','call',?,1,1)")
            .bind(userId),
          db
            .prepare(`INSERT INTO hosted_compacted_conversations
        SELECT user_id,hosted_session_id,'compacted',max(sequence),1,'compaction',?
        FROM transcript_entries GROUP BY user_id,hosted_session_id`)
            .bind(now),
          db.prepare("DELETE FROM transcript_entries WHERE user_id=?").bind(userId),
        ])
      );
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM hosted_turn_retention").first("count")
        )
      ).toBe(1);
      const before = observeRetentionCost(db);
      yield* expireHostedPending({ db: before.database, userId, now });
      expect(before.cost().rowsRead).toBeLessThanOrEqual(50);
      expect(before.cost().rowsWritten).toBe(0);
      yield* expireHostedPending({ db, userId, now: now + hostedTranscriptRetentionMs });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM hosted_mutation_commits").first("count")
        )
      ).toBe(0);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM hosted_turn_retention").first("count")
        )
      ).toBe(0);
    })
  ));

it("drains channel event backlogs without losing their parent deadline or touching another User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() => seedHistory(db));
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(`INSERT INTO hosted_whatsapp_inbound
        (turn_id,user_id,portfolio_id,bsuid,message_id,business_phone_number_id,occurred_at_ms,received_at_ms)
        SELECT id,user_id,'p','b',id,'phone',1,1 FROM hosted_turns WHERE id IN ('retired-1','other-retired')`),
          db.prepare(`INSERT INTO hosted_whatsapp_delivery
        (turn_id,user_id,text,correlation_token,business_phone_number_id,proposed_at_ms,state,send_started_at_ms)
        SELECT turn_id,user_id,'retained',turn_id,'phone',1,'accepted',1 FROM hosted_whatsapp_inbound`),
          db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<600)
        INSERT INTO hosted_whatsapp_delivery_events SELECT 'retired-1','message-'||i,'sent',1,1 FROM n`),
          db.prepare(
            "INSERT INTO hosted_whatsapp_delivery_events VALUES ('other-retired','foreign-message','sent',1,1)"
          ),
          db.prepare(
            "INSERT INTO hosted_whatsapp_outbox SELECT turn_id,user_id,NULL,1 FROM hosted_whatsapp_inbound"
          ),
        ])
      );
      for (let tick = 0; tick < 3; tick += 1) {
        const observed = observeRetentionCost(db);
        yield* expireHostedPending({ db: observed.database, userId, now });
        expect(observed.cost().rowsRead).toBeLessThanOrEqual(3_000);
        expect(observed.cost().rowsWritten).toBeLessThanOrEqual(1_000);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT count(*) AS count FROM hosted_whatsapp_delivery_events WHERE correlation_token='retired-1'"
              )
              .first("count")
          )
        ).toBe(600 - 200 * (tick + 1));
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT count(*) AS count FROM hosted_turn_retention WHERE turn_id='retired-1'"
              )
              .first("count")
          )
        ).toBe(tick < 2 ? 1 : 0);
      }
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM hosted_whatsapp_delivery_events WHERE correlation_token='other-retired'"
            )
            .first("count")
        )
      ).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT user_id FROM hosted_whatsapp_delivery").first("user_id")
        )
      ).toBe(otherUserId);
    })
  ));
