import { hostedTranscriptRetentionMs } from "./contract";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { observeRetentionCost } from "../d1-test-fixture";
import { schemaDefinition, schemaStatements } from "../schema-cutover.test-fixture";

const candidateDefinition = (transcript: string): string =>
  transcript
    .replace('"transcript_entries"', '"derived_transcript"')
    .replace("  hosted_session_id TEXT NOT NULL,\n", "")
    .replace(
      "  FOREIGN KEY (user_id, hosted_session_id) REFERENCES hosted_agent_sessions(user_id, id),\n",
      ""
    );

const candidateIndexes = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source
    .filter(
      (sql) =>
        /^CREATE (UNIQUE )?INDEX /u.test(sql) &&
        / ON transcript_entries\(/u.test(sql) &&
        !sql.includes("hosted_session_id")
    )
    .map((sql) =>
      sql
        .replace(/INDEX (\w+)/u, "INDEX derived_$1")
        .replace("ON transcript_entries(", "ON derived_transcript(")
    );

const seedNativeHistory = Effect.fn(function* (
  db: D1Database,
  userId: string,
  source: ReadonlyArray<string>
) {
  const transcript = schemaDefinition({ source, target: "transcript_entries" });
  const setupGuards = ["hosted_turns_begin_pending", "hosted_turn_requires_consent"];
  yield* Effect.tryPromise(() =>
    db.batch([
      ...setupGuards.map((name) => db.prepare(`DROP TRIGGER ${name}`)),
      db
        .prepare(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<15)
 INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status)
 SELECT 'cost-session-'||i,?,'{}',i*172800000,'idle-ended' FROM n`)
        .bind(userId),
      db
        .prepare(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1500)
 INSERT INTO hosted_turns(id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status)
 SELECT 'cost-turn-'||i,?,'cost-session-'||((i-1)/100+1),i*1728000,i*1728000+1,'completed' FROM n`)
        .bind(userId),
      ...setupGuards.map((target) => db.prepare(schemaDefinition({ source, target }))),
      db.prepare(`INSERT INTO transcript_entries(id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,text)
 SELECT id||'-user',user_id,hosted_session_id,id,'user',started_at_ms,'Original User text' FROM hosted_turns WHERE id LIKE 'cost-turn-%'`),
      db.prepare(`INSERT INTO transcript_entries(id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,text)
 SELECT id||'-assistant',user_id,hosted_session_id,id,'assistant',terminal_at_ms,'Visible reply' FROM hosted_turns WHERE id LIKE 'cost-turn-%'`),
      db.prepare(candidateDefinition(transcript)),
      db.prepare(
        "CREATE INDEX cost_session_turn_cover ON hosted_turns(user_id,hosted_session_id,id,status)"
      ),
      db.prepare(`INSERT INTO derived_transcript(sequence,id,user_id,turn_id,kind,occurred_at_ms,text,failure_reason,iteration,tool_call_id,operation,input_json,outcome_json)
 SELECT sequence,id,user_id,turn_id,kind,occurred_at_ms,text,failure_reason,iteration,tool_call_id,operation,input_json,outcome_json FROM transcript_entries`),
      ...candidateIndexes(source).map((sql) => db.prepare(sql)),
    ])
  );
});

type OwnershipQuery = Readonly<{
  phase: string;
  current: string;
  derived: string;
  params: ReadonlyArray<string | number>;
}>;
const readQueries = (
  userId: string,
  session: string,
  cursor: number
): ReadonlyArray<OwnershipQuery> => {
  const common =
    "e.sequence,e.id,e.turn_id,e.occurred_at_ms,e.kind,e.text,e.failure_reason,e.iteration,e.tool_call_id,e.operation,e.input_json,e.outcome_json,t.status";
  return [
    {
      phase: "session",
      current: `SELECT ${common} FROM transcript_entries e JOIN hosted_turns t ON t.id=e.turn_id AND t.user_id=e.user_id WHERE e.user_id=? AND e.hosted_session_id=? ORDER BY e.sequence LIMIT 201`,
      derived: `SELECT ${common} FROM hosted_turns t CROSS JOIN derived_transcript e WHERE t.user_id=? AND t.hosted_session_id=? AND e.user_id=t.user_id AND e.turn_id=t.id ORDER BY e.sequence LIMIT 201`,
      params: [userId, session],
    },
    {
      phase: "prefix-count",
      current:
        "SELECT count(*) AS entries FROM transcript_entries WHERE user_id=? AND hosted_session_id=? AND sequence<=?",
      derived:
        "SELECT count(*) AS entries FROM hosted_turns t CROSS JOIN derived_transcript e WHERE t.user_id=? AND t.hosted_session_id=? AND e.user_id=t.user_id AND e.turn_id=t.id AND e.sequence<=?",
      params: [userId, session, cursor],
    },
    {
      phase: "pending-prefix",
      current:
        "SELECT e.sequence FROM transcript_entries e JOIN hosted_turns t ON t.id=e.turn_id AND t.user_id=e.user_id WHERE e.user_id=? AND e.hosted_session_id=? AND e.sequence<=? AND t.status='pending' LIMIT 1",
      derived:
        "SELECT e.sequence FROM hosted_turns t INDEXED BY hosted_turns_one_pending JOIN derived_transcript e ON e.user_id=t.user_id AND e.turn_id=t.id WHERE t.user_id=? AND t.hosted_session_id=? AND e.sequence<=? AND t.status='pending' LIMIT 1",
      params: [userId, session, cursor],
    },
    {
      phase: "compaction-selection",
      current:
        "SELECT sequence FROM transcript_entries WHERE user_id=? AND hosted_session_id=? AND sequence<=? ORDER BY sequence",
      derived:
        "SELECT e.sequence FROM hosted_turns t CROSS JOIN derived_transcript e WHERE t.user_id=? AND t.hosted_session_id=? AND e.user_id=t.user_id AND e.turn_id=t.id AND e.sequence<=? ORDER BY e.sequence",
      params: [userId, session, cursor],
    },
    {
      phase: "cleanup-selection",
      current:
        "SELECT e.sequence FROM (SELECT id AS turn_id,user_id FROM hosted_turns WHERE user_id=? AND retention_terminal_at_ms<? ORDER BY retention_terminal_at_ms,id LIMIT 100) r CROSS JOIN transcript_entries e WHERE e.user_id=r.user_id AND e.turn_id=r.turn_id LIMIT 200",
      derived:
        "SELECT e.sequence FROM (SELECT id AS turn_id,user_id FROM hosted_turns WHERE user_id=? AND retention_terminal_at_ms<? ORDER BY retention_terminal_at_ms,id LIMIT 100) r CROSS JOIN derived_transcript e WHERE e.user_id=r.user_id AND e.turn_id=r.turn_id LIMIT 200",
      params: [userId, hostedTranscriptRetentionMs + 1],
    },
  ];
};

const Measurement = Schema.Struct({
  sample: Schema.Int,
  phase: Schema.String,
  mode: Schema.String,
  rowsRead: Schema.Int,
  rowsWritten: Schema.Int,
  milliseconds: Schema.Finite,
  plans: Schema.Array(Schema.String),
});

/** Native candidate storage for the accepted Transcript ownership cost gate, never runtime SQL. */
export const measureTranscriptOwnership = Effect.fn(function* (db: D1Database, userId: string) {
  const source = schemaStatements(
    yield* Effect.tryPromise(() =>
      Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
    )
  );
  yield* seedNativeHistory(db, userId, source);
  const session = "cost-session-15";
  const cursor = yield* Effect.tryPromise(() =>
    db
      .prepare(
        "SELECT max(sequence) FROM transcript_entries WHERE user_id=? AND hosted_session_id=?"
      )
      .bind(userId, session)
      .first<number>("max(sequence)")
  );
  if (cursor === null) return yield* Effect.die("Missing candidate prefix");
  const queries = readQueries(userId, session, cursor);
  const measurements = [];
  for (let sample = 0; sample < 3; sample++) {
    for (const query of queries) {
      const results = [];
      for (const mode of sample % 2 === 0
        ? (["current", "derived"] as const)
        : (["derived", "current"] as const)) {
        const sql = mode === "current" ? query.current : query.derived;
        const observed = observeRetentionCost(db);
        const started = performance.now();
        const rows = yield* Effect.tryPromise(() =>
          observed.database
            .prepare(sql)
            .bind(...query.params)
            .all()
        );
        const milliseconds = performance.now() - started;
        results.push(rows.results);
        measurements.push({
          sample,
          phase: query.phase,
          mode,
          ...observed.cost(),
          milliseconds,
          plans: yield* Effect.tryPromise(() => observed.plans()),
        });
      }
      expect(results[0]).toEqual(results[1]);
    }
  }
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Measurement)))(
    measurements
  );
  yield* Effect.tryPromise(() =>
    Bun.write(
      new URL("../../test-results/transcript-session-measurements.json", import.meta.url),
      encoded
    )
  );
});
