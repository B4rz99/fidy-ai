import { measureTranscriptOwnership } from "./transcript-cost.test-fixture";
import { Config, Effect, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases, observeRetentionCost } from "../d1-test-fixture";
import { UserId } from "../../src/core/identity/contract";
import { makeAgentRetention } from "./runtime";
import { expireHostedPending, hostedTranscriptRetentionMs } from "./internal/turn-store";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = UserId.make("10000000-0000-4000-8000-000000000001");
const otherUserId = UserId.make("10000000-0000-4000-8000-000000000002");
const day = 86_400_000;
const now = 200 * day;
const setup = (): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      yield* Effect.tryPromise(() =>
        db.batch(
          [userId, otherUserId].flatMap((user) => [
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO', 'es-CO', 'UTC', 0)"
              )
              .bind(user),
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
            .prepare(
              `UPDATE hosted_agent_sessions SET compacted_text=incoming.text,compacted_through_sequence=incoming.through_sequence,compacted_revision=incoming.revision,compacted_at_ms=incoming.updated_at_ms FROM (SELECT user_id AS user_id,id AS hosted_session_id,'retained' AS text,0 AS through_sequence,1 AS revision,? AS updated_at_ms FROM hosted_agent_sessions WHERE id LIKE 'compact-%') AS incoming WHERE hosted_agent_sessions.user_id=incoming.user_id AND hosted_agent_sessions.id=incoming.hosted_session_id AND hosted_agent_sessions.compacted_revision IS NULL`
            )
            .bind(now),
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000)
      INSERT INTO resource_admission_counters(policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,owner_user_id) SELECT 'hosted.compaction.user.v1',?,'calendar',?+i*86400000,?+(i+1)*86400000,1,? FROM n`)
            .bind(userId, now, now, userId),
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
      SELECT id,'call',user_id,started_at_ms FROM hosted_turns WHERE id IN ('retired-1','other-retired')`),
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
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status) VALUES('other-owned-session',?,'{}',0,'idle-ended')"
          )
          .bind(userId)
          .run()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(
              "INSERT INTO transcript_entries(id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,text) VALUES('wrong-session',?,'other-owned-session','retired-2','user',1,'Wrong continuity')"
            )
            .bind(userId)
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
          db.prepare(
            `UPDATE hosted_agent_sessions SET compacted_text=incoming.text,compacted_through_sequence=incoming.through_sequence,compacted_revision=incoming.revision,compacted_at_ms=incoming.updated_at_ms FROM (SELECT user_id AS user_id,id AS hosted_session_id,'expired' AS text,0 AS through_sequence,1 AS revision,1 AS updated_at_ms FROM hosted_agent_sessions WHERE id LIKE 'old-compact-%') AS incoming WHERE hosted_agent_sessions.user_id=incoming.user_id AND hosted_agent_sessions.id=incoming.hosted_session_id AND hosted_agent_sessions.compacted_revision IS NULL`
          ),
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000)
        INSERT INTO resource_admission_counters(policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,owner_user_id) SELECT 'hosted.compaction.user.v1',?,'calendar',-i*86400000,(1-i)*86400000,1,? FROM n`)
            .bind(userId, userId),
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
            .prepare("INSERT INTO hosted_mutation_commits VALUES ('retained-1','call',?,1)")
            .bind(userId),
          db
            .prepare(
              `UPDATE hosted_agent_sessions SET compacted_text=incoming.text,compacted_through_sequence=incoming.through_sequence,compacted_revision=incoming.revision,compacted_at_ms=incoming.updated_at_ms FROM (SELECT user_id AS user_id,hosted_session_id AS hosted_session_id,'compacted' AS text,max(sequence) AS through_sequence,1 AS revision,? AS updated_at_ms FROM transcript_entries GROUP BY user_id,hosted_session_id) AS incoming WHERE hosted_agent_sessions.user_id=incoming.user_id AND hosted_agent_sessions.id=incoming.hosted_session_id AND hosted_agent_sessions.compacted_revision IS NULL`
            )
            .bind(now),
          db.prepare("DELETE FROM transcript_entries WHERE user_id=?").bind(userId),
        ])
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM (SELECT rowid,id AS turn_id,user_id AS user_id,retention_terminal_at_ms AS terminal_at_ms FROM hosted_turns WHERE retention_terminal_at_ms IS NOT NULL) AS hosted_turn_retention"
            )
            .first("count")
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
          db
            .prepare(
              "SELECT count(*) AS count FROM (SELECT rowid,id AS turn_id,user_id AS user_id,retention_terminal_at_ms AS terminal_at_ms FROM hosted_turns WHERE retention_terminal_at_ms IS NOT NULL) AS hosted_turn_retention"
            )
            .first("count")
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
          db.prepare(
            `WITH incoming(turn_id,user_id,portfolio_id,bsuid,message_id,business_phone_number_id,occurred_at_ms,received_at_ms) AS (SELECT id,user_id,'p','b',id,'phone',1,1 FROM hosted_turns WHERE id IN ('retired-1','other-retired')) UPDATE hosted_turns SET inbound_portfolio_id=incoming.portfolio_id,inbound_bsuid=incoming.bsuid,inbound_message_id=incoming.message_id,inbound_business_phone_number_id=incoming.business_phone_number_id,inbound_occurred_at_ms=incoming.occurred_at_ms,inbound_received_at_ms=incoming.received_at_ms FROM incoming WHERE hosted_turns.id=incoming.turn_id AND hosted_turns.user_id=incoming.user_id`
          ),
          db.prepare(
            `INSERT INTO whatsapp_deliveries AS hosted_whatsapp_delivery(kind,turn_id,user_id,text,correlation_token,business_phone_number_id,proposed_at_ms,state,send_started_at_ms) SELECT 'hosted', turn_id,user_id,'retained',turn_id,'phone',1,'accepted',1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL)`
          ),
          db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<600)
        INSERT INTO whatsapp_event_records(kind,correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms) SELECT 'delivery-status','retired-1','message-'||i,'sent',1,1 FROM n`),
          db.prepare(
            "INSERT INTO whatsapp_event_records(kind,correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms) VALUES ('delivery-status','other-retired','foreign-message','sent',1,1)"
          ),
          db.prepare(
            "UPDATE hosted_turns SET dispatch_offered_at_ms=incoming.offered_at_ms,dispatch_created_at_ms=incoming.created_at_ms FROM (SELECT turn_id AS turn_id,user_id AS user_id,NULL AS offered_at_ms,1 AS created_at_ms FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL)) AS incoming WHERE hosted_turns.id=incoming.turn_id AND hosted_turns.dispatch_created_at_ms IS NULL"
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
                "SELECT count(*) AS count FROM (SELECT rowid,correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms FROM whatsapp_event_records WHERE kind='delivery-status') WHERE correlation_token='retired-1'"
              )
              .first("count")
          )
        ).toBe(600 - 200 * (tick + 1));
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT count(*) AS count FROM (SELECT rowid,id AS turn_id,user_id AS user_id,retention_terminal_at_ms AS terminal_at_ms FROM hosted_turns WHERE retention_terminal_at_ms IS NOT NULL) AS hosted_turn_retention WHERE turn_id='retired-1'"
              )
              .first("count")
          )
        ).toBe(tick < 2 ? 1 : 0);
      }
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM (SELECT rowid,correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms FROM whatsapp_event_records WHERE kind='delivery-status') WHERE correlation_token='other-retired'"
            )
            .first("count")
        )
      ).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT user_id FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery"
            )
            .first("user_id")
        )
      ).toBe(otherUserId);
    })
  ));

const measureOwnership =
  Effect.runSync(Config.String("INFRA_PERFORMANCE_MEASURE").pipe(Config.withDefault("0"))) === "1";
it.skipIf(!measureOwnership)(
  "measures native session ownership reads and compaction/cleanup selection at retained bounds",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        yield* measureTranscriptOwnership(db, userId);
      })
    )
);
