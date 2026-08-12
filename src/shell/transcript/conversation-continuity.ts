import {
  Array as Arr,
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
  SchemaTransformation,
  Semaphore,
  Struct,
} from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
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

const preparedAttemptContextTypeId: unique symbol = Symbol.for(
  "fidy-ai/shell/conversation-continuity/PreparedAttemptContext"
);

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
 * Attempt-scoped input for the WorkingContext owner. It binds one User, active request, durable
 * revision, and ConversationContinuity scope without exposing those persistence facts.
 */
export type PreparedAttemptContext = Readonly<{
  readonly [preparedAttemptContextTypeId]: typeof preparedAttemptContextTypeId;
}>;

/** The prepared continuity changed before admission; no active User entry was appended. */
export class ContinuityChanged extends Data.TaggedError("ContinuityChanged")<{}> {}

/**
 * Operations for exactly one admitted Pending Turn. Inputs contain semantic content only. A method
 * retained after terminalization, supersession, or callback closure dies as a programming defect.
 */
export type PendingTurn = Readonly<{
  append: (entries: Arr.NonEmptyReadonlyArray<TurnContinuationContent>) => Effect.Effect<void>;
  complete: (assistant: DeliveredAssistantContent) => Effect.Effect<void>;
  fail: (reason: TurnFailureReason) => Effect.Effect<void>;
}>;

/**
 * One prepared attempt bound to its durable revision and callback scope. `begin` atomically admits
 * the captured active request as a generated Pending Turn or reports `ContinuityChanged`.
 */
export type PreparedAttempt = Readonly<{
  context: PreparedAttemptContext;
  view: ContinuityView;
  begin: () => Effect.Effect<PendingTurn, ContinuityChanged>;
}>;

/**
 * User-bound operations for one hosted attempt. A newer preparation supersedes every capability
 * from the prior preparation.
 */
export type SerializedAttempt = Readonly<{
  prepare: <A, E, R>(
    use: (prepared: PreparedAttempt) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
}>;

/**
 * Observes durable continuity or runs a callback in one User-bound capability scope. Semantic
 * input is validated before use; capability misuse dies as a defect, and `ContinuityChanged` is
 * the sole continuity-specific recoverable failure exposed by a prepared attempt.
 */
export type ConversationContinuityService = Readonly<{
  observe: (userId: UserId) => Effect.Effect<ContinuityView>;
  withSerializedAttempt: <A, E, R>(
    userId: UserId,
    request: ActiveTurnRequest,
    use: (attempt: SerializedAttempt) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
}>;

type CryptoService = Effect.Success<typeof Crypto.Crypto>;
type Dependencies = {
  readonly crypto: CryptoService;
  readonly sql: SqlClient.SqlClient;
};
type PreparedPersistence = {
  readonly revision: bigint;
  readonly view: ContinuityView;
};
type CapabilityScope = {
  active: boolean;
  generation: number;
  readonly mutationPermit: Semaphore.Semaphore;
};
type PendingScope = {
  active: boolean;
  lastOccurredAt: DateTime.Utc;
};

const RevisionRow = Schema.Struct({ revision: Schema.BigIntFromString });
const PersistedTranscriptEntry = Schema.toCodecJson(TranscriptEntry);
const TranscriptEntryRow = Schema.Struct({ entry: PersistedTranscriptEntry });
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
      startedAt: Schema.DateTimeUtcFromDate,
      latestEntryAt: Schema.DateTimeUtcFromDate,
    }),
    execute: (ownedUserId) => sql`
      SELECT turn.id, turn.started_at AS "startedAt",
        max((entry.entry->>'occurredAt')::timestamptz) AS "latestEntryAt"
      FROM conversation_turns AS turn
      JOIN transcript_entries AS entry
        ON entry.user_id = turn.user_id AND entry.turn_id = turn.id
      WHERE turn.user_id = ${ownedUserId} AND turn.state = 'Pending'
      GROUP BY turn.id, turn.started_at
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
  userId: UserId
) {
  return yield* inUserTransaction(
    dependencies.sql,
    userId,
    Effect.gen(function* () {
      yield* recoverPending(dependencies, userId);
      return yield* observePersisted(dependencies.sql, userId);
    })
  ).pipe(persistenceOrDie);
});

type BeginPersistence = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly revision: bigint;
  readonly entry: UserTranscriptEntry;
};

const beginPersisted = Effect.fn("ConversationContinuity.begin")(function* ({
  dependencies,
  userId,
  revision,
  entry,
}: BeginPersistence) {
  return yield* inUserTransaction(
    dependencies.sql,
    userId,
    Effect.gen(function* () {
      yield* ensureContinuity(dependencies.sql, userId);
      if ((yield* readRevision(dependencies.sql, userId, true)) !== revision) {
        return yield* new ContinuityChanged();
      }
      yield* dependencies.sql`
        INSERT INTO conversation_turns (user_id, id, state, started_at)
        VALUES (${userId}, ${entry.turnId}, 'Pending', ${entry.occurredAt})
      `;
      yield* appendEntry(dependencies.sql, userId, entry);
      yield* incrementRevision(dependencies.sql, userId);
    })
  ).pipe(
    Effect.catch((error) =>
      error instanceof ContinuityChanged
        ? Effect.fail(error)
        : Effect.die(new InvalidPersistedContinuity())
    )
  );
});

type AppendPersistence = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly turnId: TranscriptTurnId;
  readonly entries: Arr.NonEmptyReadonlyArray<TranscriptEntry>;
};

const appendPersisted = Effect.fn("ConversationContinuity.append")(function* ({
  dependencies,
  userId,
  turnId,
  entries,
}: AppendPersistence) {
  yield* inUserTransaction(
    dependencies.sql,
    userId,
    Effect.gen(function* () {
      yield* requirePending(dependencies.sql, userId, turnId);
      for (const entry of entries) yield* appendEntry(dependencies.sql, userId, entry);
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
  readonly terminal: TerminalTurn;
};

const terminalizePersisted = Effect.fn("ConversationContinuity.terminalize")(function* ({
  dependencies,
  userId,
  terminal,
}: TerminalPersistence) {
  const { occurredAt: terminalAt, turnId } = terminal.entry;
  yield* inUserTransaction(
    dependencies.sql,
    userId,
    Effect.gen(function* () {
      yield* requirePending(dependencies.sql, userId, turnId);
      yield* appendEntry(dependencies.sql, userId, terminal.entry);
      yield* dependencies.sql`
        UPDATE conversation_turns
        SET state = ${terminal._tag}, terminal_at = ${terminalAt},
          failure_reason = ${terminal._tag === "Failed" ? terminal.entry.reason : null}
        WHERE user_id = ${userId} AND id = ${turnId} AND state = 'Pending'
      `;
      yield* incrementRevision(dependencies.sql, userId);
    })
  ).pipe(persistenceOrDie);
});

const capabilityDefect = (message: string): Effect.Effect<never> =>
  Effect.die(new Error(`ConversationContinuity capability ${message}.`));

class InvalidSemanticTurnContent extends Data.TaggedError("InvalidSemanticTurnContent")<{}> {}

const claimCapability = (
  isActive: () => boolean,
  consume: () => void,
  message: string
): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (!isActive()) return capabilityDefect(message);
    consume();
    return Effect.void;
  });

const checkCapability = (isActive: () => boolean, message: string): Effect.Effect<void> =>
  Effect.suspend(() => (isActive() ? Effect.void : capabilityDefect(message)));

const nextTimestamp = (pending: PendingScope): Effect.Effect<DateTime.Utc> =>
  DateTime.now.pipe(
    Effect.map((now) => {
      const occurredAt =
        now.epochMilliseconds >= pending.lastOccurredAt.epochMilliseconds
          ? now
          : pending.lastOccurredAt;
      pending.lastOccurredAt = occurredAt;
      return occurredAt;
    })
  );

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

type PendingRuntime = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly turnId: TranscriptTurnId;
  readonly scope: PendingScope;
  readonly operationPermit: Semaphore.Semaphore;
  readonly mutationPermit: Semaphore.Semaphore;
  readonly isAttemptActive: () => boolean;
  readonly isActive: () => boolean;
};

const appendPending = (
  runtime: PendingRuntime,
  untrustedEntries: Arr.NonEmptyReadonlyArray<TurnContinuationContent>
): Effect.Effect<void> =>
  runtime.operationPermit.withPermits(1)(
    Effect.gen(function* () {
      yield* checkCapability(runtime.isActive, "was used outside its active Pending Turn");
      const contents = yield* Schema.decodeUnknownEffect(
        Schema.NonEmptyArray(TurnContinuationContentSchema)
      )(untrustedEntries).pipe(
        Effect.mapError(() => new InvalidSemanticTurnContent()),
        Effect.orDie
      );
      const occurredAt = yield* nextTimestamp(runtime.scope);
      const entries: Arr.NonEmptyArray<TranscriptEntry> = [
        makeContinuationEntry({
          content: contents[0],
          id: yield* makeEntryId(runtime.dependencies.crypto),
          turnId: runtime.turnId,
          occurredAt,
        }),
      ];
      for (const content of Arr.drop(contents, 1)) {
        entries.push(
          makeContinuationEntry({
            content,
            id: yield* makeEntryId(runtime.dependencies.crypto),
            turnId: runtime.turnId,
            occurredAt,
          })
        );
      }
      yield* runtime.mutationPermit.withPermits(1)(
        checkCapability(runtime.isActive, "was superseded before its Pending Turn mutation").pipe(
          Effect.andThen(appendPersisted({ ...runtime, entries }))
        )
      );
    })
  );

const claimPendingTerminalization = (runtime: PendingRuntime): Effect.Effect<void> =>
  claimCapability(
    runtime.isActive,
    () => {
      runtime.scope.active = false;
    },
    "was reused after terminalization or scope closure"
  );

const terminalizePending: <Content>(
  runtime: PendingRuntime,
  decodeContent: Effect.Effect<Content>,
  makeTerminal: (content: Content, id: TranscriptEntryId, terminalAt: DateTime.Utc) => TerminalTurn
) => Effect.Effect<void> = (runtime, decodeContent, makeTerminal) =>
  runtime.operationPermit.withPermits(1)(
    Effect.gen(function* () {
      yield* checkCapability(runtime.isActive, "was reused after terminalization or scope closure");
      const content = yield* decodeContent;
      yield* claimPendingTerminalization(runtime);
      const terminalAt = yield* nextTimestamp(runtime.scope);
      const terminal = makeTerminal(
        content,
        yield* makeEntryId(runtime.dependencies.crypto),
        terminalAt
      );
      yield* runtime.mutationPermit.withPermits(1)(
        checkCapability(runtime.isAttemptActive, "was superseded before terminalization").pipe(
          Effect.andThen(
            terminalizePersisted({
              dependencies: runtime.dependencies,
              userId: runtime.userId,
              terminal,
            })
          )
        )
      );
    })
  );

const completePending = (
  runtime: PendingRuntime,
  untrustedAssistant: DeliveredAssistantContent
): Effect.Effect<void> =>
  terminalizePending(
    runtime,
    Schema.decodeUnknownEffect(DeliveredAssistantContentSchema)(untrustedAssistant).pipe(
      Effect.mapError(() => new InvalidSemanticTurnContent()),
      Effect.orDie
    ),
    (assistant, id, terminalAt) => ({
      _tag: "Completed",
      entry: AssistantTranscriptEntry.make({
        ...assistant,
        id,
        turnId: runtime.turnId,
        occurredAt: terminalAt,
      }),
    })
  );

const failPending = (
  runtime: PendingRuntime,
  untrustedReason: TurnFailureReason
): Effect.Effect<void> =>
  terminalizePending(
    runtime,
    Schema.decodeUnknownEffect(TurnFailureReason)(untrustedReason).pipe(
      Effect.mapError(() => new InvalidSemanticTurnContent()),
      Effect.orDie
    ),
    (reason, id, terminalAt) => ({
      _tag: "Failed",
      entry: FailedTurnTranscriptEntry.make({
        id,
        turnId: runtime.turnId,
        reason,
        occurredAt: terminalAt,
      }),
    })
  );

type PendingTurnInput = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly turnId: TranscriptTurnId;
  readonly attemptScope: CapabilityScope;
  readonly preparation: CapabilityScope;
  readonly generation: number;
  readonly startedAt: DateTime.Utc;
};

const makePendingTurn = (input: PendingTurnInput): PendingTurn => {
  const scope: PendingScope = { active: true, lastOccurredAt: input.startedAt };
  const isAttemptActive = (): boolean =>
    input.attemptScope.active &&
    input.preparation.active &&
    input.attemptScope.generation === input.generation;
  const runtime: PendingRuntime = {
    dependencies: input.dependencies,
    userId: input.userId,
    turnId: input.turnId,
    scope,
    operationPermit: Semaphore.makeUnsafe(1),
    mutationPermit: input.attemptScope.mutationPermit,
    isAttemptActive,
    isActive: () => isAttemptActive() && scope.active,
  };
  return Object.freeze({
    append: (entries) => appendPending(runtime, entries),
    complete: (assistant) => completePending(runtime, assistant),
    fail: (reason) => failPending(runtime, reason),
  });
};

type PreparedAttemptInput<A, E, R> = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly request: ActiveTurnRequest;
  readonly attemptScope: CapabilityScope;
  readonly generation: number;
  readonly persisted: PreparedPersistence;
  readonly use: (prepared: PreparedAttempt) => Effect.Effect<A, E, R>;
};

type BeginPreparedAttempt = {
  readonly input: Omit<PreparedAttemptInput<unknown, unknown, unknown>, "use">;
  readonly preparation: CapabilityScope;
  readonly isBeginActive: () => boolean;
  readonly isAttemptActive: () => boolean;
  readonly consumeBegin: () => void;
};

const beginPreparedAttempt = ({
  input,
  preparation,
  isBeginActive,
  isAttemptActive,
  consumeBegin,
}: BeginPreparedAttempt): Effect.Effect<PendingTurn, ContinuityChanged> =>
  Effect.gen(function* () {
    yield* claimCapability(
      isBeginActive,
      consumeBegin,
      "was reused after begin, supersession, or scope closure"
    );
    const startedAt = yield* DateTime.now;
    const turnId = yield* makeTurnId(input.dependencies.crypto);
    const entry = UserTranscriptEntry.make({
      ...input.request,
      id: yield* makeEntryId(input.dependencies.crypto),
      turnId,
      occurredAt: startedAt,
    });
    yield* input.attemptScope.mutationPermit.withPermits(1)(
      checkCapability(isAttemptActive, "was superseded before admission").pipe(
        Effect.andThen(
          beginPersisted({
            dependencies: input.dependencies,
            userId: input.userId,
            revision: input.persisted.revision,
            entry,
          })
        )
      )
    );
    return makePendingTurn({ ...input, turnId, preparation, startedAt });
  });

const usePreparedAttempt = <A, E, R>(
  input: PreparedAttemptInput<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const { dependencies, userId, request, attemptScope, generation, persisted, use } = input;
    const preparation: CapabilityScope = {
      active: true,
      generation,
      mutationPermit: attemptScope.mutationPermit,
    };
    let beginAvailable = true;
    const isAttemptActive = (): boolean =>
      attemptScope.active && preparation.active && attemptScope.generation === generation;
    const isBeginActive = (): boolean => isAttemptActive() && beginAvailable;
    const context: PreparedAttemptContext = Object.freeze({
      [preparedAttemptContextTypeId]: preparedAttemptContextTypeId,
    });
    const prepared: PreparedAttempt = Object.freeze({
      context,
      view: persisted.view,
      begin: () =>
        beginPreparedAttempt({
          input: {
            dependencies,
            userId,
            request,
            attemptScope,
            generation,
            persisted,
          },
          preparation,
          isBeginActive,
          isAttemptActive,
          consumeBegin: () => {
            beginAvailable = false;
          },
        }),
    });
    return use(prepared).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          preparation.active = false;
        })
      )
    );
  });

type SerializedAttemptInput = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly request: ActiveTurnRequest;
  readonly attemptScope: CapabilityScope;
};

const makeSerializedAttempt = ({
  dependencies,
  userId,
  request,
  attemptScope,
}: SerializedAttemptInput): SerializedAttempt =>
  Object.freeze({
    prepare: <A, E, R>(
      use: (prepared: PreparedAttempt) => Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const generation = yield* attemptScope.mutationPermit.withPermits(1)(
          Effect.suspend(() => {
            if (!attemptScope.active) {
              return capabilityDefect("was used after its User scope closed");
            }
            attemptScope.generation += 1;
            return Effect.succeed(attemptScope.generation);
          })
        );
        const persisted = yield* preparePersisted(dependencies, userId);
        yield* checkCapability(
          () => attemptScope.active && attemptScope.generation === generation,
          "was superseded during preparation"
        );
        return yield* usePreparedAttempt({
          dependencies,
          userId,
          request,
          attemptScope,
          generation,
          persisted,
          use,
        });
      }),
  });

type SerializedAttemptUse<A, E, R> = {
  readonly dependencies: Dependencies;
  readonly userId: UserId;
  readonly untrustedRequest: ActiveTurnRequest;
  readonly use: (attempt: SerializedAttempt) => Effect.Effect<A, E, R>;
};

const withSerializedAttemptOwned = <A, E, R>({
  dependencies,
  userId,
  untrustedRequest,
  use,
}: SerializedAttemptUse<A, E, R>): Effect.Effect<A, E, R> =>
  Schema.decodeUnknownEffect(ActiveTurnRequestSchema)(untrustedRequest).pipe(
    Effect.mapError(() => new InvalidSemanticTurnContent()),
    Effect.orDie,
    Effect.flatMap((request) =>
      Effect.suspend(() => {
        const attemptScope: CapabilityScope = {
          active: true,
          generation: 0,
          mutationPermit: Semaphore.makeUnsafe(1),
        };
        const attempt = makeSerializedAttempt({
          dependencies,
          userId,
          request,
          attemptScope,
        });
        return use(attempt).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              attemptScope.active = false;
              attemptScope.generation += 1;
            })
          )
        );
      })
    )
  );

// Named Effect operations expose each bounded SQL workflow as a trace span. The owning hosted-Turn
// orchestration reports failures once, so this persistence module deliberately does not log them.
const makeConversationContinuity = Effect.gen(function* () {
  const dependencies: Dependencies = {
    crypto: yield* Crypto.Crypto,
    sql: yield* SqlClient.SqlClient,
  };
  const observe = (userId: UserId): Effect.Effect<ContinuityView> =>
    observeOwned(dependencies, userId);
  const withSerializedAttempt: ConversationContinuityService["withSerializedAttempt"] = (
    userId,
    request,
    use
  ) =>
    withSerializedAttemptOwned({
      dependencies,
      userId,
      untrustedRequest: request,
      use,
    });
  return {
    observe,
    withSerializedAttempt,
  } satisfies ConversationContinuityService;
});

/**
 * Owns exact Transcript admission, explicit Turn lifecycle, and abandoned-Pending recovery.
 *
 * `withSerializedAttempt` binds one User and active request to callback-scoped preparation and
 * Pending capabilities. Callers provide only semantic content; this module creates every persistence id and
 * nondecreasing lifecycle time. `prepare` recovers abandoned Pending work before exposing an exact
 * view, and `begin` admits the active User text only if that view is still current. Appends and
 * terminalization are atomic short User-scoped transactions. `ContinuityChanged` is the only typed
 * continuity failure; escaped or reused capabilities and impossible persistence states are defects.
 */
export class ConversationContinuity extends Context.Service<
  ConversationContinuity,
  ConversationContinuityService
>()("fidy-ai/shell/transcript/conversation-continuity/ConversationContinuity") {
  static readonly layer = Layer.effect(this, makeConversationContinuity);
}
