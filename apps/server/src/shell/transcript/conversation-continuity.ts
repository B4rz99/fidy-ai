import {
  Array as Arr,
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  Equal,
  Layer,
  Option,
  Schema,
  SchemaTransformation,
  Struct,
} from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import type { CompactedConversation } from "~/core/transcript/compacted-conversation";
import {
  ConversationCompactionTokenCount,
  defaultCompactionMaximumTokens,
  defaultCompactionTriggerTokens,
} from "~/core/transcript/compaction-policy";
import { HostedAgentSessionId } from "~/core/transcript/hosted-agent-session";
import { withSubjectLock } from "~/shell/consent/repo";
import {
  ConversationCompactionInference,
  type ConversationCompactionInferenceService,
} from "./conversation-compaction-inference";
import { findUserInScope } from "~/shell/identity/repo";
import { selectMemoriesInScope } from "~/shell/memory/repo";
import {
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
  ConversationTurn,
  FailedTurnTranscriptEntry,
  InterruptedTurnTranscriptEntry,
  TranscriptEntry,
  TranscriptEntryId,
  TranscriptTurnId,
  TurnFailureReason,
  UserTranscriptEntry,
} from "~/core/transcript/model";
import { withUserTransaction } from "~/shell/db/user-transaction";
import {
  HostedAgentSessionConsentRequired,
  admitHostedAgentSession,
  hostedAgentSessionConsentStandsInScope,
  requireHostedAgentSession,
  requireHostedAgentSessionInScope,
} from "./hosted-agent-session";

export { HostedAgentSessionConsentRequired };

const ActiveTurnRequestSchema = UserTranscriptEntry.mapFields(Struct.pick(["text"]));
const CanonicalToolCallContent = CanonicalToolCallEntry.mapFields(
  Struct.omit(["id", "turnId", "occurredAt"])
);
const CanonicalToolResultContent = CanonicalToolResultEntry.mapFields(
  Struct.omit(["id", "turnId", "occurredAt"])
);
const TurnContinuationContentSchema = Schema.Union([
  CanonicalToolCallContent,
  CanonicalToolResultContent,
]);
const DeliveredAssistantContentSchema = AssistantTranscriptEntry.mapFields(
  Struct.pick(["iteration", "text"])
);

/** The exact active request without caller-owned persistence identity or time. */
export type ActiveTurnRequest = typeof ActiveTurnRequestSchema.Type;

/** Canonical call or outcome content; persistence identity, Turn, and time are module-owned. */
export type TurnContinuationContent = typeof TurnContinuationContentSchema.Type;

/** Visible assistant content; persistence identity, Turn, and time are module-owned. */
export type DeliveredAssistantContent = typeof DeliveredAssistantContentSchema.Type;

/** Read-only continuity state in authoritative Transcript order. */
export type ContinuityView = {
  readonly entries: ReadonlyArray<TranscriptEntry>;
  readonly turns: ReadonlyArray<ConversationTurn>;
};

/**
 * Exact WorkingContext input for one prepared Turn. Plain data: it carries no authority and no
 * liveness, so the hosted runtime owns whether its own preparation is still current.
 */
export type PreparedWorkingContextSnapshot = Readonly<{
  user: Effect.Success<ReturnType<typeof findUserInScope>>;
  memories: Effect.Success<ReturnType<typeof selectMemoriesInScope>>;
  transcript: ReadonlyArray<TranscriptEntry>;
  compactedConversation: Option.Option<CompactedConversation>;
  request: ActiveTurnRequest;
  hostedAgentSessionId: HostedAgentSessionId;
  startedAt: DateTime.Utc;
}>;

/** The prepared continuity changed before admission; no active User entry was appended. */
export class ContinuityChanged extends Data.TaggedError("ContinuityChanged")<{}> {}

/** The durable Pending Turn admitted for one prepared snapshot. */
export type AdmittedTurn = Readonly<{
  turnId: TranscriptTurnId;
  hostedAgentSessionId: HostedAgentSessionId;
}>;

/** The exact durable revision one preparation observed, replayed on admission as a precondition. */
export type PreparedRevision = Readonly<{
  revision: bigint;
  memoryRevision: bigint;
}>;

/** One prepared Turn: the snapshot the runtime reads and the preconditions admission rechecks. */
export type PreparedTurnContext = Readonly<{
  snapshot: PreparedWorkingContextSnapshot;
  observed: PreparedRevision;
}>;

const compactionInferenceTimeout = "30 seconds";

/** Internal commit tags used only by the deterministic concurrency probe. */
type CompactionCommitTag = "Committed" | "Stale";

/** Test-only metadata hook; production uses its no-op default.
 * @internal
 */
const noCompactionCommitObservation = (_tag: CompactionCommitTag): Effect.Effect<void> =>
  Effect.void;

export const CompactionCommitObserver = Context.Reference<
  (tag: CompactionCommitTag) => Effect.Effect<void>
>("@fidy/server/shell/transcript/conversation-continuity/CompactionCommitObserver", {
  defaultValue: (): typeof noCompactionCommitObservation => noCompactionCommitObservation,
});

export type ConversationCompactionPolicy = Readonly<{
  triggerTokens: ConversationCompactionTokenCount;
  maximumTokens: ConversationCompactionTokenCount;
}>;

/** Provider-token trigger and replacement bound validated as positive whole counts. */
export const ConversationCompactionPolicy = Context.Reference<ConversationCompactionPolicy>(
  "@fidy/server/shell/transcript/conversation-continuity/ConversationCompactionPolicy",
  {
    defaultValue: () => ({
      triggerTokens: ConversationCompactionTokenCount.make(defaultCompactionTriggerTokens),
      maximumTokens: ConversationCompactionTokenCount.make(defaultCompactionMaximumTokens),
    }),
  }
);

/**
 * Durable Transcript, Hosted Agent Session, and Turn-lifecycle persistence. Every operation takes
 * and returns plain data: identities, snapshots, and semantic content. No operation hands back a
 * mutable handle, so the hosted runtime alone decides how long a Turn's authority lives.
 *
 * Semantic input is validated before use, persistence identity and every nondecreasing lifecycle
 * time are module-owned, and an impossible persisted state dies as a defect. `ContinuityChanged` is
 * the only continuity-specific recoverable failure.
 */
export type ConversationContinuityService = Readonly<{
  observe: (userId: UserId) => Effect.Effect<ContinuityView>;
  /** Continues the active Hosted Agent Session or admits one against current onboarding Consent. */
  admitSession: (
    userId: UserId
  ) => Effect.Effect<HostedAgentSessionId, HostedAgentSessionConsentRequired>;
  /** Rechecks explicit revocation before any Transcript leaves this module. */
  requireSession: (
    userId: UserId,
    hostedAgentSessionId: HostedAgentSessionId
  ) => Effect.Effect<void, HostedAgentSessionConsentRequired>;
  /** Recovers abandoned Pending work, compacts if needed, and reads the exact session snapshot. */
  prepareTurn: (
    userId: UserId,
    hostedAgentSessionId: HostedAgentSessionId,
    request: ActiveTurnRequest
  ) => Effect.Effect<PreparedTurnContext>;
  /** Admits one prepared Turn durably as Pending, or reports that continuity moved on. */
  admitTurn: (input: {
    readonly userId: UserId;
    readonly prepared: PreparedTurnContext;
  }) => Effect.Effect<AdmittedTurn, ContinuityChanged | HostedAgentSessionConsentRequired>;
  /** Appends canonical continuation content to a Turn that must still be Pending. */
  appendTurn: (input: {
    readonly userId: UserId;
    readonly turnId: TranscriptTurnId;
    readonly entries: Arr.NonEmptyReadonlyArray<TurnContinuationContent>;
  }) => Effect.Effect<void>;
  /** Terminalizes a Pending Turn as Completed. A Turn that is no longer Pending is a defect. */
  completeTurn: (input: {
    readonly userId: UserId;
    readonly turnId: TranscriptTurnId;
    readonly assistant: DeliveredAssistantContent;
  }) => Effect.Effect<void>;
  /** Terminalizes a Pending Turn as Failed. A Turn that is no longer Pending is a defect. */
  failTurn: (input: {
    readonly userId: UserId;
    readonly turnId: TranscriptTurnId;
    readonly reason: TurnFailureReason;
  }) => Effect.Effect<void>;
}>;

type CryptoService = Effect.Success<typeof Crypto.Crypto>;
type Dependencies = {
  readonly crypto: CryptoService;
  readonly sql: SqlClient.SqlClient;
  readonly inference: ConversationCompactionInferenceService;
  readonly compactionPolicy: ConversationCompactionPolicy;
  readonly observeCompactionCommit: (tag: CompactionCommitTag) => Effect.Effect<void>;
};
type PreparedPersistence = {
  readonly hostedAgentSessionId: HostedAgentSessionId;
  readonly revision: bigint;
  readonly memoryRevision: bigint;
  readonly view: ContinuityView;
  readonly user: Effect.Success<ReturnType<typeof findUserInScope>>;
  readonly memories: Effect.Success<ReturnType<typeof selectMemoriesInScope>>;
  readonly startedAt: DateTime.Utc;
  readonly compactedConversation: Option.Option<CompactedConversation>;
  readonly sequencedEntries: ReadonlyArray<{
    sequence: bigint;
    entry: TranscriptEntry;
  }>;
  readonly consentStands: boolean;
};
const RevisionRow = Schema.Struct({ revision: Schema.BigIntFromString });
const MemoryRevisionRow = Schema.Struct({ revision: Schema.BigIntFromString });
const PersistedTranscriptEntry = Schema.toCodecJson(TranscriptEntry);
const TranscriptEntryRow = Schema.Struct({ entry: PersistedTranscriptEntry });
const SequencedTranscriptEntryRow = Schema.Struct({
  sequence: Schema.BigIntFromString,
  entry: PersistedTranscriptEntry,
});
const CompactedConversationRow = Schema.Struct({
  text: Schema.String,
  throughSequence: Schema.BigIntFromString,
  revision: Schema.BigIntFromString,
  updatedAt: Schema.DateTimeUtcFromDate,
});
const OptionalFailureReason = Schema.OptionFromNullOr(TurnFailureReason);
class InvalidPersistedContinuity extends Data.TaggedError("InvalidPersistedContinuity")<{}> {}

const persistenceOrDie = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
  effect.pipe(
    Effect.mapError(() => new InvalidPersistedContinuity()),
    Effect.orDie
  );

const StoredTurnRow = Schema.Struct({
  id: TranscriptTurnId,
  state: Schema.Literals(["Pending", "Completed", "Failed", "Interrupted"]),
  startedAt: Schema.DateTimeUtcFromDate,
  terminalAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  failureReason: OptionalFailureReason,
}).pipe(
  Schema.decodeTo(
    Schema.toType(ConversationTurn),
    SchemaTransformation.transform({
      decode: (row): ConversationTurn => {
        switch (row.state) {
          case "Pending":
            return { _tag: "Pending", id: row.id, startedAt: row.startedAt };
          case "Completed":
            return {
              _tag: "Completed",
              id: row.id,
              startedAt: row.startedAt,
              terminalAt: Option.getOrThrow(row.terminalAt),
            };
          case "Failed":
            return {
              _tag: "Failed",
              id: row.id,
              startedAt: row.startedAt,
              terminalAt: Option.getOrThrow(row.terminalAt),
              reason: Option.getOrThrow(row.failureReason),
            };
          case "Interrupted":
            return {
              _tag: "Interrupted",
              id: row.id,
              startedAt: row.startedAt,
              terminalAt: Option.getOrThrow(row.terminalAt),
            };
        }
      },
      encode: (turn) => ({
        id: turn.id,
        state: turn._tag,
        startedAt: turn.startedAt,
        terminalAt: turn._tag === "Pending" ? Option.none() : Option.some(turn.terminalAt),
        failureReason: turn._tag === "Failed" ? Option.some(turn.reason) : Option.none(),
      }),
    })
  )
);

const inUserTransaction = <A, E>(
  sql: SqlClient.SqlClient,
  userId: UserId,
  effect: Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  withUserTransaction(userId, effect).pipe(Effect.provideService(SqlClient.SqlClient, sql));

const ensureContinuity = Effect.fn("ConversationContinuity.ensure")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId
) {
  yield* sql`
    INSERT INTO conversation_continuity (user_id)
    VALUES (${userId})
    ON CONFLICT (user_id) DO NOTHING
  `;
});

const readRevision = Effect.fn("ConversationContinuity.readRevision")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  lock: boolean
) {
  const row = yield* SqlSchema.findOne({
    Request: UserId,
    Result: RevisionRow,
    execute: (ownedUserId) =>
      lock
        ? sql`
            SELECT revision::text AS revision
            FROM conversation_continuity
            WHERE user_id = ${ownedUserId}
            FOR UPDATE
          `
        : sql`
            SELECT revision::text AS revision
            FROM conversation_continuity
            WHERE user_id = ${ownedUserId}
          `,
  })(userId);
  return row.revision;
});

const readMemoryRevision = Effect.fn("ConversationContinuity.readMemoryRevision")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId
) {
  const row = yield* SqlSchema.findOne({
    Request: UserId,
    Result: MemoryRevisionRow,
    execute: (ownedUserId) => sql`
      SELECT COALESCE(memory.revision, 0)::text AS revision
      FROM users AS subject
      LEFT JOIN memory_revisions AS memory ON memory.user_id = subject.id
      WHERE subject.id = ${ownedUserId}
    `,
  })(userId);
  return row.revision;
});

const readContinuityView = Effect.fn("ConversationContinuity.readView")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId
) {
  const entryRows = yield* SqlSchema.findAll({
    Request: UserId,
    Result: TranscriptEntryRow,
    execute: (ownedUserId) => sql`
      SELECT entry FROM transcript_entries
      WHERE user_id = ${ownedUserId}
      ORDER BY sequence
    `,
  })(userId);
  const turnRows = yield* SqlSchema.findAll({
    Request: UserId,
    Result: StoredTurnRow,
    execute: (ownedUserId) => sql`
      SELECT id, state, started_at AS "startedAt", terminal_at AS "terminalAt",
        failure_reason AS "failureReason"
      FROM conversation_turns
      WHERE user_id = ${ownedUserId}
      ORDER BY started_at, id
    `,
  })(userId);
  return {
    entries: entryRows.map(({ entry }) => entry),
    turns: turnRows,
  };
});

const readSessionContinuityView = Effect.fn("ConversationContinuity.readSessionView")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  hostedAgentSessionId: HostedAgentSessionId
) {
  const request = { userId, hostedAgentSessionId };
  const entryRows = yield* SqlSchema.findAll({
    Request: Schema.Struct({ userId: UserId, hostedAgentSessionId: HostedAgentSessionId }),
    Result: TranscriptEntryRow,
    execute: (owned) => sql`
      SELECT entry.entry FROM transcript_entries AS entry
      JOIN conversation_turns AS turn
        ON turn.user_id = entry.user_id AND turn.id = entry.turn_id
      WHERE entry.user_id = ${owned.userId}
        AND turn.session_id = ${owned.hostedAgentSessionId}
      ORDER BY entry.sequence
    `,
  })(request);
  const turnRows = yield* SqlSchema.findAll({
    Request: Schema.Struct({ userId: UserId, hostedAgentSessionId: HostedAgentSessionId }),
    Result: StoredTurnRow,
    execute: (owned) => sql`
      SELECT id, state, started_at AS "startedAt", terminal_at AS "terminalAt",
        failure_reason AS "failureReason"
      FROM conversation_turns
      WHERE user_id = ${owned.userId} AND session_id = ${owned.hostedAgentSessionId}
      ORDER BY started_at, id
    `,
  })(request);
  return { entries: entryRows.map(({ entry }) => entry), turns: turnRows };
});

const readCompactedConversation = Effect.fn("ConversationContinuity.readCompacted")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  hostedAgentSessionId: HostedAgentSessionId
) {
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: UserId, hostedAgentSessionId: HostedAgentSessionId }),
    Result: CompactedConversationRow,
    execute: (owned) => sql`
      SELECT text, through_sequence::text AS "throughSequence", revision::text AS revision,
        updated_at AS "updatedAt"
      FROM compacted_conversations
      WHERE user_id = ${owned.userId} AND session_id = ${owned.hostedAgentSessionId}
    `,
  })({ userId, hostedAgentSessionId });
});

const observePersisted = Effect.fn("ConversationContinuity.observePersisted")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId
) {
  yield* ensureContinuity(sql, userId);
  return {
    revision: yield* readRevision(sql, userId, false),
    view: yield* readContinuityView(sql, userId),
  };
});

const appendEntry = Effect.fn("ConversationContinuity.appendEntry")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  entry: TranscriptEntry
) {
  yield* SqlSchema.findOne({
    Request: Schema.Struct({
      userId: UserId,
      entryId: TranscriptEntryId,
      turnId: TranscriptTurnId,
      entry: PersistedTranscriptEntry,
    }),
    Result: Schema.Struct({ entryId: TranscriptEntryId }),
    execute: (row) => sql`
      INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
      VALUES (${row.userId}, ${row.entryId}, ${row.turnId}, ${row.entry}::jsonb)
      RETURNING entry_id AS "entryId"
    `,
  })({ userId, entryId: entry.id, turnId: entry.turnId, entry });
});

const requirePending = Effect.fn("ConversationContinuity.requirePending")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  turnId: TranscriptTurnId
) {
  const row = yield* SqlSchema.findOne({
    Request: Schema.Struct({ userId: UserId, turnId: TranscriptTurnId }),
    Result: Schema.Struct({ state: Schema.String }),
    execute: (request) => sql`
      SELECT state FROM conversation_turns
      WHERE user_id = ${request.userId} AND id = ${request.turnId}
      FOR UPDATE
    `,
  })({ userId, turnId });
  if (row.state !== "Pending") {
    return yield* Effect.die(new Error("ConversationContinuity Turn is already terminal."));
  }
});

const incrementRevision = Effect.fn("ConversationContinuity.incrementRevision")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId
) {
  yield* sql`
    UPDATE conversation_continuity SET revision = revision + 1
    WHERE user_id = ${userId}
  `;
});

const makeEntryId = (crypto: CryptoService): Effect.Effect<TranscriptEntryId> =>
  crypto.randomUUIDv7.pipe(
    Effect.map((id) => TranscriptEntryId.make(id)),
    Effect.orDie
  );

const makeTurnId = (crypto: CryptoService): Effect.Effect<TranscriptTurnId> =>
  crypto.randomUUIDv7.pipe(
    Effect.map((id) => TranscriptTurnId.make(id)),
    Effect.orDie
  );

const recoverPending = Effect.fn("ConversationContinuity.recoverPending")(function* (
  dependencies: Dependencies,
  userId: UserId
) {
  const { crypto, sql } = dependencies;
  yield* ensureContinuity(sql, userId);
  const pending = yield* SqlSchema.findAll({
    Request: UserId,
    Result: Schema.Struct({
      id: TranscriptTurnId,
      hostedAgentSessionId: HostedAgentSessionId,
      startedAt: Schema.DateTimeUtcFromDate,
      latestEntryAt: Schema.DateTimeUtcFromDate,
    }),
    execute: (ownedUserId) => sql`
      SELECT turn.id, turn.session_id AS "hostedAgentSessionId",
        turn.started_at AS "startedAt",
        max((entry.entry->>'occurredAt')::timestamptz) AS "latestEntryAt"
      FROM conversation_turns AS turn
      JOIN transcript_entries AS entry
        ON entry.user_id = turn.user_id AND entry.turn_id = turn.id
      WHERE turn.user_id = ${ownedUserId} AND turn.state = 'Pending'
      GROUP BY turn.id, turn.session_id, turn.started_at
      ORDER BY turn.started_at, turn.id
    `,
  })(userId);
  for (const turn of pending) {
    const now = yield* DateTime.now;
    const latestPersistedAt =
      turn.latestEntryAt.epochMilliseconds >= turn.startedAt.epochMilliseconds
        ? turn.latestEntryAt
        : turn.startedAt;
    const terminalAt =
      now.epochMilliseconds >= latestPersistedAt.epochMilliseconds ? now : latestPersistedAt;
    yield* appendEntry(
      sql,
      userId,
      InterruptedTurnTranscriptEntry.make({
        id: yield* makeEntryId(crypto),
        turnId: turn.id,
        occurredAt: terminalAt,
      })
    );
    yield* sql`
      UPDATE conversation_turns SET state = 'Interrupted', terminal_at = ${terminalAt}
      WHERE user_id = ${userId} AND id = ${turn.id} AND state = 'Pending'
    `;
    yield* sql`
      UPDATE hosted_agent_sessions
      SET last_terminal_turn_at = GREATEST(
        COALESCE(last_terminal_turn_at, ${terminalAt}), ${terminalAt}
      )
      WHERE user_id = ${userId} AND id = ${turn.hostedAgentSessionId}
    `;
  }
  if (pending.length > 0) yield* incrementRevision(sql, userId);
});

const observeOwned = Effect.fn("ConversationContinuity.observe")(function* (
  dependencies: Dependencies,
  userId: UserId
) {
  return yield* inUserTransaction(
    dependencies.sql,
    userId,
    readContinuityView(dependencies.sql, userId)
  ).pipe(persistenceOrDie);
});

const preparePersisted = Effect.fn("ConversationContinuity.prepare")(function* (
  dependencies: Dependencies,
  userId: UserId,
  hostedAgentSessionId: HostedAgentSessionId
) {
  return yield* inUserTransaction(
    dependencies.sql,
    userId,
    Effect.gen(function* () {
      yield* recoverPending(dependencies, userId);
      const persisted = yield* observePersisted(dependencies.sql, userId);
      const sessionView = yield* readSessionContinuityView(
        dependencies.sql,
        userId,
        hostedAgentSessionId
      );
      const memoryRevision = yield* readMemoryRevision(dependencies.sql, userId);
      const user = yield* findUserInScope(userId).pipe(
        Effect.provideService(SqlClient.SqlClient, dependencies.sql)
      );
      const memories = yield* selectMemoriesInScope(userId).pipe(
        Effect.provideService(SqlClient.SqlClient, dependencies.sql)
      );
      return {
        ...persisted,
        hostedAgentSessionId,
        view: sessionView,
        memoryRevision,
        user,
        memories,
        startedAt: yield* DateTime.now,
        compactedConversation: yield* readCompactedConversation(
          dependencies.sql,
          userId,
          hostedAgentSessionId
        ),
        sequencedEntries: yield* SqlSchema.findAll({
          Request: Schema.Struct({ userId: UserId, hostedAgentSessionId: HostedAgentSessionId }),
          Result: SequencedTranscriptEntryRow,
          execute: (owned) => dependencies.sql`
            SELECT entry.sequence::text AS sequence, entry.entry
            FROM transcript_entries AS entry
            JOIN conversation_turns AS turn
              ON turn.user_id = entry.user_id AND turn.id = entry.turn_id
            WHERE entry.user_id = ${owned.userId}
              AND turn.session_id = ${owned.hostedAgentSessionId}
            ORDER BY entry.sequence
          `,
        })({ userId, hostedAgentSessionId }),
        consentStands: yield* hostedAgentSessionConsentStandsInScope(userId, hostedAgentSessionId),
      };
    }).pipe(Effect.provideService(SqlClient.SqlClient, dependencies.sql))
  ).pipe(persistenceOrDie);
});

type CompactionSelection = Readonly<{
  entries: ReadonlyArray<{ sequence: bigint; entry: TranscriptEntry }>;
  throughSequence: bigint;
}>;

const terminalCompactionPrefixes = (
  persisted: PreparedPersistence
): ReadonlyArray<ReadonlyArray<{ sequence: bigint; entry: TranscriptEntry }>> => {
  const turnsById = new Map(persisted.view.turns.map((turn) => [String(turn.id), turn]));
  const prefixes: Array<Array<{ sequence: bigint; entry: TranscriptEntry }>> = [];
  const selected: Array<{ sequence: bigint; entry: TranscriptEntry }> = [];
  let activeTurnId = Option.none<string>();
  for (const sequenced of persisted.sequencedEntries) {
    const turnId = String(sequenced.entry.turnId);
    const turn = turnsById.get(turnId);
    if (turn === undefined || turn._tag === "Pending") break;
    if (Option.isSome(activeTurnId) && activeTurnId.value !== turnId) prefixes.push([...selected]);
    selected.push(sequenced);
    activeTurnId = Option.some(turnId);
  }
  if (selected.length > 0) prefixes.push([...selected]);
  return prefixes;
};

// Selection keeps the Pending barrier, complete-Turn grouping, and threshold edge explicit.
const selectCompactionPrefix = Effect.fn("ConversationContinuity.selectCompactionPrefix")(
  function* (dependencies: Dependencies, persisted: PreparedPersistence) {
    const terminalPrefixes = terminalCompactionPrefixes(persisted);
    if (terminalPrefixes.length === 0) return Option.none<CompactionSelection>();
    const completePrefix = Option.getOrThrow(Arr.last(terminalPrefixes));
    const allTokens = yield* dependencies.inference.countTranscript(
      completePrefix.map(({ entry }) => entry)
    );
    if (allTokens < dependencies.compactionPolicy.triggerTokens) {
      return Option.none<CompactionSelection>();
    }
    let low = 0;
    let high = terminalPrefixes.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const prefix = Option.getOrThrow(Arr.get(terminalPrefixes, middle));
      const tokens = yield* dependencies.inference.countTranscript(
        prefix.map(({ entry }) => entry)
      );
      if (tokens >= dependencies.compactionPolicy.triggerTokens) high = middle;
      else low = middle + 1;
    }
    const thresholdPrefix = Option.getOrThrow(Arr.get(terminalPrefixes, low));
    const terminal = Option.getOrThrow(Arr.last(thresholdPrefix));
    return Option.some({ entries: thresholdPrefix, throughSequence: terminal.sequence });
  }
);

type CompactionCommit = Readonly<{
  dependencies: Dependencies;
  userId: UserId;
  persisted: PreparedPersistence;
  selection: CompactionSelection;
  text: string;
}>;

type CompactionCommitResult = Readonly<{ _tag: "Committed" }> | Readonly<{ _tag: "Stale" }>;

type CompactionStaleness = Readonly<{
  persisted: PreparedPersistence;
  selection: CompactionSelection;
  revision: bigint;
  memoryRevision: bigint;
  consentStands: boolean;
  prior: Option.Option<CompactedConversation>;
  currentRows: ReadonlyArray<{ sequence: bigint; entry: TranscriptEntry }>;
}>;

/** Compares every optimistic precondition the compaction commit depends on. */
const isCompactionStale = (input: CompactionStaleness): boolean => {
  const samePrior = Option.match(input.persisted.compactedConversation, {
    onNone: () => Option.isNone(input.prior),
    onSome: (expected) => Option.isSome(input.prior) && Equal.equals(input.prior.value, expected),
  });
  const sameEntries =
    input.currentRows.length === input.selection.entries.length &&
    input.currentRows.every((row, index) => Equal.equals(row, input.selection.entries[index]));
  return (
    input.revision !== input.persisted.revision ||
    input.memoryRevision !== input.persisted.memoryRevision ||
    input.consentStands !== input.persisted.consentStands ||
    !samePrior ||
    !sameEntries
  );
};

/** Reads every optimistic precondition the commit depends on, under the already-held lock. */
const readCompactionPreconditions = Effect.fn("ConversationContinuity.readCompactionPreconditions")(
  function* ({ dependencies, userId, persisted, selection }: CompactionCommit) {
    const revision = yield* readRevision(dependencies.sql, userId, true);
    const memoryRevision = yield* readMemoryRevision(dependencies.sql, userId);
    const consentStands = yield* hostedAgentSessionConsentStandsInScope(
      userId,
      persisted.hostedAgentSessionId
    );
    const prior = yield* readCompactedConversation(
      dependencies.sql,
      userId,
      persisted.hostedAgentSessionId
    );
    const currentRows = yield* SqlSchema.findAll({
      Request: Schema.Struct({ userId: UserId, hostedAgentSessionId: HostedAgentSessionId }),
      Result: SequencedTranscriptEntryRow,
      execute: (owned) => dependencies.sql`
      SELECT entry.sequence::text AS sequence, entry.entry
      FROM transcript_entries AS entry
      JOIN conversation_turns AS turn
        ON turn.user_id = entry.user_id AND turn.id = entry.turn_id
      WHERE entry.user_id = ${owned.userId}
        AND turn.session_id = ${owned.hostedAgentSessionId}
        AND entry.sequence <= ${selection.throughSequence}
      ORDER BY entry.sequence`,
    })({ userId, hostedAgentSessionId: persisted.hostedAgentSessionId });
    return { revision, memoryRevision, consentStands, prior, currentRows } as const;
  }
);

/** Replaces the session's compaction and prunes the entries it now stands for, as one step. */
const replaceCompaction = Effect.fn("ConversationContinuity.replaceCompaction")(function* (
  { dependencies, userId, persisted, selection, text }: CompactionCommit,
  prior: Option.Option<CompactedConversation>
) {
  const now = yield* DateTime.now;
  const nextRevision = Option.match(prior, {
    onNone: () => 1n,
    onSome: (value) => value.revision + 1n,
  });
  yield* dependencies.sql`
    INSERT INTO compacted_conversations
      (user_id, session_id, text, through_sequence, revision, updated_at)
    VALUES (
      ${userId}, ${persisted.hostedAgentSessionId}, ${text},
      ${selection.throughSequence}, ${nextRevision}, ${now}
    )
    ON CONFLICT (user_id, session_id) DO UPDATE SET
      text = EXCLUDED.text,
      through_sequence = EXCLUDED.through_sequence,
      revision = EXCLUDED.revision,
      updated_at = EXCLUDED.updated_at
  `;
  yield* dependencies.sql`DELETE FROM transcript_entries AS entry
    USING conversation_turns AS turn
    WHERE entry.user_id = ${userId} AND entry.sequence <= ${selection.throughSequence}
      AND turn.user_id = entry.user_id AND turn.id = entry.turn_id
      AND turn.session_id = ${persisted.hostedAgentSessionId}`;
  yield* incrementRevision(dependencies.sql, userId);
});

// One cohesive transaction keeps every optimistic comparison adjacent to replacement and deletion.
const commitCompactionTransaction = Effect.fn("ConversationContinuity.commitCompactionTransaction")(
  function* (input: CompactionCommit) {
    const { dependencies, persisted, selection, userId } = input;
    return yield* withSubjectLock(
      userId,
      Effect.gen(function* () {
        const observed = yield* readCompactionPreconditions(input);
        if (isCompactionStale({ persisted, selection, ...observed })) {
          return { _tag: "Stale" } as const satisfies CompactionCommitResult;
        }
        yield* replaceCompaction(input, observed.prior);
        return { _tag: "Committed" } as const satisfies CompactionCommitResult;
      }).pipe(Effect.provideService(SqlClient.SqlClient, dependencies.sql))
    ).pipe(Effect.provideService(SqlClient.SqlClient, dependencies.sql));
  }
);

const commitCompaction = Effect.fn("ConversationContinuity.commitCompaction")(function* (
  input: CompactionCommit
) {
  const result = yield* commitCompactionTransaction(input);
  yield* input.dependencies.observeCompactionCommit(result._tag);
  return result;
});

const compactIfNeeded = Effect.fn("ConversationContinuity.compactIfNeeded")(function* (
  dependencies: Dependencies,
  userId: UserId,
  persisted: PreparedPersistence
) {
  const selection = yield* selectCompactionPrefix(dependencies, persisted);
  if (Option.isNone(selection)) return false;
  const generated = yield* dependencies.inference
    .generate(
      Option.map(persisted.compactedConversation, ({ text }) => text),
      selection.value.entries.map(({ entry }) => entry)
    )
    .pipe(Effect.timeoutOption(compactionInferenceTimeout));
  if (Option.isNone(generated)) return false;
  const tokens = yield* dependencies.inference.countText(generated.value.compactedConversation);
  if (tokens > dependencies.compactionPolicy.maximumTokens) return false;
  return yield* commitCompaction({
    dependencies,
    userId,
    persisted,
    selection: selection.value,
    text: generated.value.compactedConversation,
  });
});

const recoverCompactionFailure = (): Effect.Effect<boolean> =>
  Effect.logWarning("Conversation Compaction failed", { error: "compaction_failed" }).pipe(
    Effect.as(false)
  );

const prepareWithCompaction = Effect.fn("ConversationContinuity.prepareWithCompaction")(function* (
  dependencies: Dependencies,
  userId: UserId,
  hostedAgentSessionId: HostedAgentSessionId
) {
  const persisted = yield* preparePersisted(dependencies, userId, hostedAgentSessionId);
  if (!persisted.consentStands) return persisted;
  yield* compactIfNeeded(dependencies, userId, persisted).pipe(
    Effect.catchCause(recoverCompactionFailure)
  );
  return yield* preparePersisted(dependencies, userId, hostedAgentSessionId);
});

const prepareCoherent = Effect.fn("ConversationContinuity.prepareCoherent")(prepareWithCompaction);

type BeginPersistence = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly hostedAgentSessionId: HostedAgentSessionId;
  readonly revision: bigint;
  readonly memoryRevision: bigint;
  readonly entry: UserTranscriptEntry;
};

// The subject lock is taken before the durable Pending Turn is written, so a Consent revocation
// racing this admission either loses the lock and closes the session first, or lands afterwards
// against a Turn that already exists as evidence.
const beginPersisted = Effect.fn("ConversationContinuity.begin")(function* ({
  dependencies,
  userId,
  hostedAgentSessionId,
  revision,
  memoryRevision,
  entry,
}: BeginPersistence) {
  return yield* inUserTransaction(
    dependencies.sql,
    userId,
    withSubjectLock(
      userId,
      Effect.gen(function* () {
        yield* requireHostedAgentSessionInScope(userId, hostedAgentSessionId);
        yield* ensureContinuity(dependencies.sql, userId);
        const continuityRevision = yield* readRevision(dependencies.sql, userId, true);
        const currentMemoryRevision = yield* readMemoryRevision(dependencies.sql, userId);
        if (continuityRevision !== revision || currentMemoryRevision !== memoryRevision) {
          return yield* new ContinuityChanged();
        }
        yield* dependencies.sql`
          INSERT INTO conversation_turns (user_id, session_id, id, state, started_at)
          VALUES (
            ${userId}, ${hostedAgentSessionId}, ${entry.turnId}, 'Pending', ${entry.occurredAt}
          )
        `;
        yield* appendEntry(dependencies.sql, userId, entry);
        yield* incrementRevision(dependencies.sql, userId);
      })
    ).pipe(Effect.provideService(SqlClient.SqlClient, dependencies.sql))
  ).pipe(
    Effect.catch((error) =>
      error instanceof ContinuityChanged || error instanceof HostedAgentSessionConsentRequired
        ? Effect.fail(error)
        : Effect.die(new InvalidPersistedContinuity())
    )
  );
});

class InvalidSemanticTurnContent extends Data.TaggedError("InvalidSemanticTurnContent")<{}> {}

const decodeSemantic = <Decoded, Encoded>(
  schema: Schema.Codec<Decoded, Encoded>,
  untrusted: Decoded
): Effect.Effect<Decoded> =>
  Schema.decodeUnknownEffect(schema)(untrusted).pipe(
    Effect.mapError(() => new InvalidSemanticTurnContent()),
    Effect.orDie
  );

/**
 * The next nondecreasing lifecycle time for one Turn, derived inside its own transaction from the
 * persisted maximum. Deriving it here keeps time generation module-owned without a mutable scope
 * crossing a module boundary.
 */
const nextTurnTimestamp = Effect.fn("ConversationContinuity.nextTurnTimestamp")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  turnId: TranscriptTurnId
) {
  const row = yield* SqlSchema.findOne({
    Request: Schema.Struct({ userId: UserId, turnId: TranscriptTurnId }),
    Result: Schema.Struct({ latestAt: Schema.DateTimeUtcFromDate }),
    execute: (owned) => sql`
      SELECT GREATEST(
        turn.started_at,
        COALESCE(max((entry.entry->>'occurredAt')::timestamptz), turn.started_at)
      ) AS "latestAt"
      FROM conversation_turns AS turn
      LEFT JOIN transcript_entries AS entry
        ON entry.user_id = turn.user_id AND entry.turn_id = turn.id
      WHERE turn.user_id = ${owned.userId} AND turn.id = ${owned.turnId}
      GROUP BY turn.started_at`,
  })({ userId, turnId });
  const now = yield* DateTime.now;
  return now.epochMilliseconds >= row.latestAt.epochMilliseconds ? now : row.latestAt;
});

type ContinuationEntryInput = {
  readonly content: TurnContinuationContent;
  readonly id: TranscriptEntryId;
  readonly turnId: TranscriptTurnId;
  readonly occurredAt: DateTime.Utc;
};

const makeContinuationEntry = ({
  content,
  id,
  turnId,
  occurredAt,
}: ContinuationEntryInput): TranscriptEntry =>
  content._tag === "CanonicalToolCallEntry"
    ? CanonicalToolCallEntry.make({ ...content, id, turnId, occurredAt })
    : CanonicalToolResultEntry.make({ ...content, id, turnId, occurredAt });

type AppendPersistence = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly turnId: TranscriptTurnId;
  readonly contents: Arr.NonEmptyReadonlyArray<TurnContinuationContent>;
};

// A Turn that already reached a terminal state cannot be appended to again through any path:
// `requirePending` inside the transaction is what makes append once-only per lifecycle.
const appendPersisted = Effect.fn("ConversationContinuity.append")(function* ({
  dependencies,
  userId,
  turnId,
  contents,
}: AppendPersistence) {
  yield* inUserTransaction(
    dependencies.sql,
    userId,
    Effect.gen(function* () {
      yield* requirePending(dependencies.sql, userId, turnId);
      const occurredAt = yield* nextTurnTimestamp(dependencies.sql, userId, turnId);
      for (const content of contents) {
        yield* appendEntry(
          dependencies.sql,
          userId,
          makeContinuationEntry({
            content,
            id: yield* makeEntryId(dependencies.crypto),
            turnId,
            occurredAt,
          })
        );
      }
      yield* incrementRevision(dependencies.sql, userId);
    })
  ).pipe(persistenceOrDie);
});

type TerminalTurn =
  | Readonly<{ _tag: "Completed"; entry: AssistantTranscriptEntry }>
  | Readonly<{ _tag: "Failed"; entry: FailedTurnTranscriptEntry }>;

type TerminalPersistence = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly turnId: TranscriptTurnId;
  readonly makeTerminal: (id: TranscriptEntryId, terminalAt: DateTime.Utc) => TerminalTurn;
};

// A second complete or fail for the same Turn finds no Pending row and dies as a defect:
// `requirePending` inside the transaction is what makes terminalization once-only.
const terminalizePersisted = Effect.fn("ConversationContinuity.terminalize")(function* ({
  dependencies,
  userId,
  turnId,
  makeTerminal,
}: TerminalPersistence) {
  yield* inUserTransaction(
    dependencies.sql,
    userId,
    Effect.gen(function* () {
      yield* requirePending(dependencies.sql, userId, turnId);
      const terminalAt = yield* nextTurnTimestamp(dependencies.sql, userId, turnId);
      const terminal = makeTerminal(yield* makeEntryId(dependencies.crypto), terminalAt);
      yield* appendEntry(dependencies.sql, userId, terminal.entry);
      yield* dependencies.sql`
        UPDATE conversation_turns
        SET state = ${terminal._tag}, terminal_at = ${terminalAt},
          failure_reason = ${terminal._tag === "Failed" ? terminal.entry.reason : null}
        WHERE user_id = ${userId} AND id = ${turnId} AND state = 'Pending'
      `;
      yield* dependencies.sql`
        UPDATE hosted_agent_sessions AS session
        SET last_terminal_turn_at = GREATEST(
          COALESCE(session.last_terminal_turn_at, ${terminalAt}), ${terminalAt}
        )
        FROM conversation_turns AS turn
        WHERE turn.user_id = ${userId} AND turn.id = ${turnId}
          AND session.user_id = turn.user_id AND session.id = turn.session_id
      `;
      yield* incrementRevision(dependencies.sql, userId);
    })
  ).pipe(persistenceOrDie);
});

type TurnMutation = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly turnId: TranscriptTurnId;
};

const appendTurnOwned = (
  mutation: TurnMutation,
  untrustedEntries: Arr.NonEmptyReadonlyArray<TurnContinuationContent>
): Effect.Effect<void> =>
  decodeSemantic(Schema.NonEmptyArray(TurnContinuationContentSchema), untrustedEntries).pipe(
    Effect.flatMap((contents) => appendPersisted({ ...mutation, contents }))
  );

const completeTurnOwned = (
  mutation: TurnMutation,
  untrustedAssistant: DeliveredAssistantContent
): Effect.Effect<void> =>
  decodeSemantic(DeliveredAssistantContentSchema, untrustedAssistant).pipe(
    Effect.flatMap((assistant) =>
      terminalizePersisted({
        ...mutation,
        makeTerminal: (id, terminalAt) => ({
          _tag: "Completed",
          entry: AssistantTranscriptEntry.make({
            ...assistant,
            id,
            turnId: mutation.turnId,
            occurredAt: terminalAt,
          }),
        }),
      })
    )
  );

const failTurnOwned = (
  mutation: TurnMutation,
  untrustedReason: TurnFailureReason
): Effect.Effect<void> =>
  decodeSemantic(TurnFailureReason, untrustedReason).pipe(
    Effect.flatMap((reason) =>
      terminalizePersisted({
        ...mutation,
        makeTerminal: (id, terminalAt) => ({
          _tag: "Failed",
          entry: FailedTurnTranscriptEntry.make({
            id,
            turnId: mutation.turnId,
            reason,
            occurredAt: terminalAt,
          }),
        }),
      })
    )
  );

type PrepareTurnInput = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly hostedAgentSessionId: HostedAgentSessionId;
  readonly untrustedRequest: ActiveTurnRequest;
};

const prepareTurnOwned = Effect.fn("ConversationContinuity.prepareTurn")(function* ({
  dependencies,
  userId,
  hostedAgentSessionId,
  untrustedRequest,
}: PrepareTurnInput) {
  const request = yield* decodeSemantic(ActiveTurnRequestSchema, untrustedRequest);
  const persisted = yield* prepareCoherent(dependencies, userId, hostedAgentSessionId);
  return {
    snapshot: {
      user: persisted.user,
      memories: persisted.memories,
      transcript: persisted.view.entries,
      compactedConversation: persisted.compactedConversation,
      request,
      hostedAgentSessionId: persisted.hostedAgentSessionId,
      startedAt: persisted.startedAt,
    },
    observed: { revision: persisted.revision, memoryRevision: persisted.memoryRevision },
  } as const satisfies PreparedTurnContext;
});

type AdmitTurnInput = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly prepared: PreparedTurnContext;
};

// The prepared snapshot is the only admission input, so the admitted text is exactly the text the
// snapshot was read for.
const admitTurnOwned = Effect.fn("ConversationContinuity.admitTurn")(function* ({
  dependencies,
  userId,
  prepared,
}: AdmitTurnInput) {
  const { hostedAgentSessionId, request, startedAt } = prepared.snapshot;
  const turnId = yield* makeTurnId(dependencies.crypto);
  const entry = UserTranscriptEntry.make({
    ...request,
    id: yield* makeEntryId(dependencies.crypto),
    turnId,
    occurredAt: startedAt,
  });
  yield* beginPersisted({
    dependencies,
    userId,
    hostedAgentSessionId,
    revision: prepared.observed.revision,
    memoryRevision: prepared.observed.memoryRevision,
    entry,
  });
  return { turnId, hostedAgentSessionId } as const satisfies AdmittedTurn;
});

// Named Effect operations expose each bounded SQL workflow as a trace span. The owning hosted-Turn
// orchestration reports failures once, so this persistence module deliberately does not log them.
const makeConversationContinuity = Effect.gen(function* () {
  const dependencies: Dependencies = {
    crypto: yield* Crypto.Crypto,
    sql: yield* SqlClient.SqlClient,
    inference: yield* ConversationCompactionInference,
    compactionPolicy: yield* ConversationCompactionPolicy,
    observeCompactionCommit: yield* CompactionCommitObserver,
  };
  const provided = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Effect.Effect<A, E> =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, dependencies.sql));
  const service: ConversationContinuityService = {
    observe: (userId) => observeOwned(dependencies, userId),
    admitSession: (userId) =>
      provided(
        admitHostedAgentSession(userId).pipe(
          Effect.provideService(Crypto.Crypto, dependencies.crypto),
          Effect.map((session) => session.id)
        )
      ),
    requireSession: (userId, hostedAgentSessionId) =>
      provided(requireHostedAgentSession(userId, hostedAgentSessionId)),
    prepareTurn: (userId, hostedAgentSessionId, request) =>
      prepareTurnOwned({ dependencies, userId, hostedAgentSessionId, untrustedRequest: request }),
    admitTurn: (input) => admitTurnOwned({ dependencies, ...input }),
    appendTurn: ({ userId, turnId, entries }) =>
      appendTurnOwned({ dependencies, userId, turnId }, entries),
    completeTurn: ({ userId, turnId, assistant }) =>
      completeTurnOwned({ dependencies, userId, turnId }, assistant),
    failTurn: ({ userId, turnId, reason }) =>
      failTurnOwned({ dependencies, userId, turnId }, reason),
  };
  return service;
});

/**
 * Owns exact Transcript admission, the durable Turn lifecycle, and abandoned-Pending recovery.
 *
 * Every operation is plain data in and plain data out; this module hands out no capability and no
 * lifecycle handle. Serializing one User's hosted work belongs to the runtime that owns the Turn,
 * which holds `withUserTurnLock` for the whole workflow so serialization spans inference and
 * delivery without one transaction spanning them. Callers supply only semantic content: this module
 * creates every persistence id and every nondecreasing lifecycle time.
 * `prepareTurn` recovers abandoned Pending work before returning an exact snapshot, `admitTurn`
 * admits the active User text only if that snapshot is still current, and append and
 * terminalization are once-only because each rechecks Pending state inside its own transaction.
 * `ContinuityChanged` is the only typed continuity failure; impossible persisted states are defects.
 */
export class ConversationContinuity extends Context.Service<
  ConversationContinuity,
  ConversationContinuityService
>()("@fidy/server/shell/transcript/conversation-continuity/ConversationContinuity") {
  static readonly layer = Layer.effect(this, makeConversationContinuity);
}
