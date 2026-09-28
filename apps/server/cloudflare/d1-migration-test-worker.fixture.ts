import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

type Env = { readonly DB: D1Database };

type TranscriptEvidence = {
  readonly sequence: number;
  readonly entryId: string;
  readonly userId: string;
  readonly hostedSessionId: string;
  readonly turnId: string;
  readonly text: string;
  readonly toolCallId: string;
  readonly mutationUserId: string;
  readonly turnStatus: string;
  readonly turnSessionId: string;
};

type Snapshot = {
  readonly appliedMigrationNames: ReadonlyArray<string>;
  readonly transcriptHasIteration: boolean;
  readonly hostedWhatsAppInboundExists: boolean;
  readonly hostedVoiceRefusalsExists: boolean;
  readonly foreignKeyViolationCount: number;
  readonly preservedEvidence: Option.Option<TranscriptEvidence>;
};

type ConstraintChecks = {
  readonly pendingTurnUniquenessEnforced: boolean;
  readonly transcriptAppendOnlyEnforced: boolean;
  readonly hostedVoiceRefusalPrimaryKeyEnforced: boolean;
  readonly hostedVoiceRefusalOutcomeCheckEnforced: boolean;
};

type MigrationState = {
  readonly appliedMigrationNames: ReadonlyArray<string>;
  readonly transcriptHasIteration: boolean;
  readonly hostedWhatsAppInboundExists: boolean;
  readonly hostedVoiceRefusalsExists: boolean;
  readonly foreignKeyViolationCount: number;
  readonly transcriptEvidence:
    | { readonly _tag: "Empty" }
    | { readonly _tag: "Preserved"; readonly value: TranscriptEvidence };
} & ConstraintChecks;

const legacyUser = "10000000-0000-4000-8000-000000000732";
const legacySession = "10000000-0000-4000-8000-000000000733";
const legacyTurn = "10000000-0000-4000-8000-000000000731";
const legacyTranscript = "10000000-0000-4000-8000-000000000735";

const runD1 = <A>(execute: () => Promise<A>): Effect.Effect<A, string> =>
  Effect.tryPromise({ try: execute, catch: (cause) => String(cause) });

const seedExistingTranscript = Effect.fn(function* (db: D1Database) {
  const timestamp = yield* Clock.currentTimeMillis;
  yield* runD1(() =>
    db.batch([
      db
        .prepare(
          `INSERT INTO users (id, service_market, locale, time_zone, created_at_ms)
           VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)`
        )
        .bind(legacyUser, timestamp),
      db
        .prepare(
          `INSERT INTO onboarding_consent_records
           (id, user_id, disclosure_json, disclosure_message_id, decision_message_id,
            decision_received_at_ms, accepted_at_ms)
           VALUES (?, ?, '{}', 'disclosed', 'accepted', ?, ?)`
        )
        .bind("10000000-0000-4000-8000-000000000734", legacyUser, timestamp, timestamp),
      db
        .prepare(
          `INSERT INTO hosted_agent_sessions
           (id, user_id, consent_basis_json, started_at_ms, status)
           VALUES (?, ?, '{}', ?, 'active')`
        )
        .bind(legacySession, legacyUser, timestamp),
      db
        .prepare(
          `INSERT INTO hosted_turns
           (id, user_id, hosted_session_id, started_at_ms, status)
           VALUES (?, ?, ?, ?, 'pending')`
        )
        .bind(legacyTurn, legacyUser, legacySession, timestamp),
      db
        .prepare(
          `INSERT INTO transcript_entries
           (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text)
           VALUES (?, ?, ?, ?, 'user', ?, 'Antes')`
        )
        .bind(legacyTranscript, legacyUser, legacySession, legacyTurn, timestamp),
      db
        .prepare(
          `INSERT INTO hosted_mutation_commits
           (turn_id, tool_call_id, user_id, committed_at_ms, valid)
           VALUES (?, 'legacy-call', ?, ?, 1)`
        )
        .bind(legacyTurn, legacyUser, timestamp),
    ])
  );
});

const statementAttempt = Effect.fn(function* (statement: D1PreparedStatement) {
  const result = yield* Effect.result(runD1(() => statement.run()));
  if (Result.isFailure(result)) return { _tag: "Failed", message: result.failure } as const;
  return { _tag: "Succeeded" } as const;
});

const readSnapshot = Effect.fn(function* (db: D1Database) {
  const [migrations, columns, tables, foreignKeys, evidence] = yield* Effect.all([
    runD1(() =>
      db.prepare("SELECT name FROM __alchemy_migrations ORDER BY name").all<{ name: string }>()
    ),
    runD1(() => db.prepare("PRAGMA table_info(transcript_entries)").all<{ name: string }>()),
    runD1(() =>
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all<{ name: string }>()
    ),
    runD1(() => db.prepare("PRAGMA foreign_key_check").all()),
    runD1(() =>
      db
        .prepare(
          `SELECT e.sequence, e.id AS entryId, e.user_id AS userId,
                  e.hosted_session_id AS hostedSessionId, e.turn_id AS turnId, e.text,
                  m.tool_call_id AS toolCallId, m.user_id AS mutationUserId,
                  t.status AS turnStatus, t.hosted_session_id AS turnSessionId
           FROM transcript_entries AS e
           JOIN hosted_mutation_commits AS m ON m.turn_id = e.turn_id
           JOIN hosted_turns AS t ON t.id = e.turn_id AND t.user_id = e.user_id
           WHERE e.turn_id = ?`
        )
        .bind(legacyTurn)
        .first<TranscriptEvidence>()
    ),
  ] as const);

  return {
    appliedMigrationNames: migrations.results.map((migration) => migration.name),
    transcriptHasIteration: columns.results.some((column) => column.name === "iteration"),
    hostedWhatsAppInboundExists: tables.results.some(
      (table) => table.name === "hosted_whatsapp_inbound"
    ),
    hostedVoiceRefusalsExists: tables.results.some(
      (table) => table.name === "hosted_voice_refusals"
    ),
    foreignKeyViolationCount: foreignKeys.results.length,
    preservedEvidence: Option.fromNullishOr(evidence),
  } satisfies Snapshot;
});

const checkExistingConstraints = Effect.fn(function* (db: D1Database) {
  const pendingTurn = yield* statementAttempt(
    db
      .prepare(
        `INSERT INTO hosted_turns
         (id, user_id, hosted_session_id, started_at_ms, status)
         VALUES (?, ?, ?, ?, 'pending')`
      )
      .bind(
        "10000000-0000-4000-8000-000000000736",
        legacyUser,
        legacySession,
        yield* Clock.currentTimeMillis
      )
  );
  const transcriptUpdate = yield* statementAttempt(
    db
      .prepare("UPDATE transcript_entries SET text = 'Tampered' WHERE id = ?")
      .bind(legacyTranscript)
  );

  return {
    pendingTurnUniquenessEnforced:
      pendingTurn._tag === "Failed" &&
      pendingTurn.message.toLowerCase().includes("unique constraint failed"),
    transcriptAppendOnlyEnforced:
      transcriptUpdate._tag === "Failed" &&
      transcriptUpdate.message.includes("transcript_append_only"),
  };
});

const checkVoiceRefusalConstraints = Effect.fn(function* (db: D1Database) {
  const timestamp = yield* Clock.currentTimeMillis;
  const portfolioId = `migration-${timestamp}-portfolio`;
  const messageId = `migration-${timestamp}-message`;
  const insertRefusal = (
    portfolio: string,
    message: string,
    outcome: string
  ): D1PreparedStatement =>
    db
      .prepare(
        `INSERT INTO hosted_voice_refusals
         (portfolio_id, message_id, user_id, claimed_at_ms, outcome)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(portfolio, message, legacyUser, timestamp, outcome);
  const insert = yield* statementAttempt(insertRefusal(portfolioId, messageId, "started"));
  const duplicate = yield* statementAttempt(insertRefusal(portfolioId, messageId, "started"));
  const differentPortfolio = yield* statementAttempt(
    insertRefusal(`${portfolioId}-other`, messageId, "started")
  );
  const differentMessage = yield* statementAttempt(
    insertRefusal(portfolioId, `${messageId}-other`, "started")
  );
  const invalidOutcome = yield* statementAttempt(
    insertRefusal(portfolioId, `${messageId}-invalid`, "invalid")
  );

  return {
    hostedVoiceRefusalPrimaryKeyEnforced:
      insert._tag === "Succeeded" &&
      duplicate._tag === "Failed" &&
      differentPortfolio._tag === "Succeeded" &&
      differentMessage._tag === "Succeeded",
    hostedVoiceRefusalOutcomeCheckEnforced:
      invalidOutcome._tag === "Failed" &&
      invalidOutcome.message.toLowerCase().includes("check constraint failed"),
  };
});

const checkConstraints = Effect.fn(function* (db: D1Database) {
  const [existing, voiceRefusal] = yield* Effect.all([
    checkExistingConstraints(db),
    checkVoiceRefusalConstraints(db),
  ] as const);
  return { ...existing, ...voiceRefusal } satisfies ConstraintChecks;
});

const readMigrationState = Effect.fn(function* (db: D1Database) {
  const snapshot = yield* readSnapshot(db);
  const constraints = Option.isSome(snapshot.preservedEvidence)
    ? yield* checkConstraints(db)
    : {
        pendingTurnUniquenessEnforced: false,
        transcriptAppendOnlyEnforced: false,
        hostedVoiceRefusalPrimaryKeyEnforced: false,
        hostedVoiceRefusalOutcomeCheckEnforced: false,
      };

  return {
    appliedMigrationNames: snapshot.appliedMigrationNames,
    transcriptHasIteration: snapshot.transcriptHasIteration,
    hostedWhatsAppInboundExists: snapshot.hostedWhatsAppInboundExists,
    hostedVoiceRefusalsExists: snapshot.hostedVoiceRefusalsExists,
    foreignKeyViolationCount: snapshot.foreignKeyViolationCount,
    transcriptEvidence: Option.match(snapshot.preservedEvidence, {
      onNone: () => ({ _tag: "Empty" as const }),
      onSome: (value) => ({ _tag: "Preserved" as const, value }),
    }),
    ...constraints,
  } satisfies MigrationState;
});

const handleRequest = Effect.fn(function* (request: Request, env: Env) {
  const { pathname } = new URL(request.url);
  if (pathname === "/seed-existing-transcript" && request.method === "POST") {
    yield* seedExistingTranscript(env.DB);
    return Response.json({ seeded: true });
  }
  if (pathname === "/state" && request.method === "GET") {
    return Response.json(yield* readMigrationState(env.DB));
  }
  return new Response("not found", { status: 404 });
});

const d1MigrationTestWorker = {
  fetch: (request: Request, env: Env): Promise<Response> =>
    Effect.runPromise(handleRequest(request, env)),
};

export default d1MigrationTestWorker;
