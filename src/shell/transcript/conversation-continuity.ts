import {
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
  SchemaTransformation,
} from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UtcTimestamp } from "~/core/_shared/time";
import { UserId } from "~/core/identity/reference";
import {
  AssistantTranscriptEntry,
  ConversationTurn,
  FailedTurnTranscriptEntry,
  InterruptedTurnTranscriptEntry,
  TranscriptEntry,
  TranscriptEntryId,
  TranscriptTurnId,
  TurnContinuationEntry,
  TurnFailureReason,
  UserTranscriptEntry,
} from "~/core/transcript/model";
import { withUserTransaction } from "~/shell/db/user-transaction";

const preparedContinuityTypeId: unique symbol = Symbol.for(
  "fidy-ai/shell/conversation-continuity/PreparedContinuity"
);
const turnHandleTypeId: unique symbol = Symbol.for(
  "fidy-ai/shell/conversation-continuity/TurnHandle"
);

/** Read-only continuity state in authoritative Transcript order. */
export type ContinuityView = {
  readonly entries: ReadonlyArray<TranscriptEntry>;
  readonly turns: ReadonlyArray<ConversationTurn>;
};

/** Opaque, single-use authority to begin against one observed User revision. */
export type PreparedContinuity = ContinuityView & {
  readonly [preparedContinuityTypeId]: typeof preparedContinuityTypeId;
};

/** Opaque authority to append and terminalize one Pending Turn. */
export type TurnHandle = {
  readonly [turnHandleTypeId]: typeof turnHandleTypeId;
};

/** The prepared revision no longer matches durable continuity; no User entry was admitted. */
export class ContinuityChanged extends Data.TaggedError("ContinuityChanged")<{}> {}

/** Preparation authority was forged, belongs to another User, or was already consumed. */
export class ContinuityAuthorityRejected extends Data.TaggedError("ContinuityAuthorityRejected")<{
  readonly reason: "Consumed" | "Foreign" | "Forged";
}> {}

/** Turn authority was forged, foreign, consumed, or paired with another Turn's entry. */
export class TurnAuthorityRejected extends Data.TaggedError("TurnAuthorityRejected")<{
  readonly reason: "Consumed" | "EntryTurnMismatch" | "Foreign" | "Forged";
}> {}

/** An entry bypassed or failed its canonical Transcript schema, so nothing was persisted. */
export class InvalidTranscriptEntry extends Data.TaggedError("InvalidTranscriptEntry")<{}> {}

/** A terminal instant is not persistable or precedes the Turn's admitted User entry. */
export class InvalidTerminalTimestamp extends Data.TaggedError("InvalidTerminalTimestamp")<{}> {}

/** A failure reason is outside the fixed lifecycle allowlist, so nothing was persisted. */
export class InvalidTurnFailureReason extends Data.TaggedError("InvalidTurnFailureReason")<{}> {}

/** The durable Turn is no longer Pending, so the requested mutation had no effect. */
export class TurnAlreadyTerminal extends Data.TaggedError("TurnAlreadyTerminal")<{}> {}

/** Exact delivered assistant evidence and its non-earlier terminal instant for successful terminalization. */
export type CompleteTurnRequest = {
  readonly entry: AssistantTranscriptEntry;
  readonly terminalAt: DateTime.Utc;
};

/** Allowlisted failure reason and its non-earlier terminal instant for failed terminalization. */
export type FailTurnRequest = {
  readonly reason: TurnFailureReason;
  readonly terminalAt: DateTime.Utc;
};

type PreparedAuthority = {
  readonly revision: bigint;
  readonly userId: UserId;
};

type TurnAuthority = {
  readonly startedAt: DateTime.Utc;
  readonly turnId: TranscriptTurnId;
  readonly userId: UserId;
};

type CryptoService = Effect.Success<typeof Crypto.Crypto>;
type Dependencies = {
  readonly authorities: AuthorityRegistry;
  readonly crypto: CryptoService;
  readonly sql: SqlClient.SqlClient;
};

const RevisionRow = Schema.Struct({ revision: Schema.BigIntFromString });
const PersistedTranscriptEntry = Schema.toCodecJson(TranscriptEntry);
const TranscriptEntryRow = Schema.Struct({ entry: PersistedTranscriptEntry });
const OptionalFailureReason = Schema.OptionFromNullOr(TurnFailureReason);
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

type PreparationRegistry = {
  readonly preparedFor: (
    userId: UserId,
    prepared: PreparedContinuity
  ) => Effect.Effect<PreparedAuthority, ContinuityAuthorityRejected>;
  readonly registerPrepared: (
    userId: UserId,
    revision: bigint,
    view: ContinuityView
  ) => PreparedContinuity;
  readonly consumePrepared: (prepared: PreparedContinuity) => void;
};

type TurnRegistry = {
  readonly turnFor: (
    userId: UserId,
    handle: TurnHandle
  ) => Effect.Effect<TurnAuthority, TurnAuthorityRejected>;
  readonly registerTurn: (userId: UserId, entry: UserTranscriptEntry) => TurnHandle;
  readonly consumeTurn: (handle: TurnHandle) => void;
  readonly consumeTurnFor: (userId: UserId, turnId: TranscriptTurnId) => void;
};

type AuthorityRegistry = PreparationRegistry & TurnRegistry;

type AuthorityRejectionReason = "Consumed" | "Foreign" | "Forged";
type AuthorityStore<Authority, Rejection> = {
  readonly find: (userId: UserId, key: object) => Effect.Effect<Authority, Rejection>;
  readonly register: (key: object, authority: Authority) => void;
  readonly consume: (key: object) => void;
};

const makeAuthorityStore = <Authority extends { readonly userId: UserId }, Rejection>(
  reject: (reason: AuthorityRejectionReason) => Rejection
): AuthorityStore<Authority, Rejection> => {
  const authorities = new WeakMap<object, Authority>();
  const consumed = new WeakSet<object>();
  return {
    find: (userId: UserId, key: object): Effect.Effect<Authority, Rejection> => {
      if (consumed.has(key)) return Effect.fail(reject("Consumed"));
      const authority = authorities.get(key);
      if (authority === undefined) return Effect.fail(reject("Forged"));
      return authority.userId === userId
        ? Effect.succeed(authority)
        : Effect.fail(reject("Foreign"));
    },
    register: (key: object, authority: Authority): void => {
      authorities.set(key, authority);
    },
    consume: (key: object): void => {
      consumed.add(key);
    },
  };
};

const makePreparationRegistry = (): PreparationRegistry => {
  const store = makeAuthorityStore<PreparedAuthority, ContinuityAuthorityRejected>(
    (reason) => new ContinuityAuthorityRejected({ reason })
  );
  return {
    preparedFor: store.find,
    registerPrepared: (userId, revision, view) => {
      const prepared: PreparedContinuity = Object.freeze({
        [preparedContinuityTypeId]: preparedContinuityTypeId,
        entries: view.entries,
        turns: view.turns,
      });
      store.register(prepared, { revision, userId });
      return prepared;
    },
    consumePrepared: store.consume,
  };
};

const makeTurnRegistry = (): TurnRegistry => {
  const store = makeAuthorityStore<TurnAuthority, TurnAuthorityRejected>(
    (reason) => new TurnAuthorityRejected({ reason })
  );
  const activeHandles = new Map<string, TurnHandle>();
  const handleKeys = new WeakMap<TurnHandle, string>();
  const authorityKey = (userId: UserId, turnId: TranscriptTurnId): string => `${userId}:${turnId}`;
  const consumeTurn = (handle: TurnHandle): void => {
    store.consume(handle);
    const key = handleKeys.get(handle);
    if (key !== undefined && activeHandles.get(key) === handle) activeHandles.delete(key);
  };
  return {
    turnFor: store.find,
    registerTurn: (userId, entry) => {
      const handle: TurnHandle = Object.freeze({ [turnHandleTypeId]: turnHandleTypeId });
      const key = authorityKey(userId, entry.turnId);
      store.register(handle, {
        userId,
        turnId: entry.turnId,
        startedAt: entry.occurredAt,
      });
      activeHandles.set(key, handle);
      handleKeys.set(handle, key);
      return handle;
    },
    consumeTurn,
    consumeTurnFor: (userId, turnId) => {
      const handle = activeHandles.get(authorityKey(userId, turnId));
      if (handle !== undefined) consumeTurn(handle);
    },
  };
};

const makeAuthorityRegistry = (): AuthorityRegistry => ({
  ...makePreparationRegistry(),
  ...makeTurnRegistry(),
});

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
  if (row.state !== "Pending") return yield* new TurnAlreadyTerminal();
});

const recoverPending = Effect.fn("ConversationContinuity.recoverPending")(function* (
  dependencies: Dependencies,
  userId: UserId
) {
  const { crypto, sql } = dependencies;
  yield* ensureContinuity(sql, userId);
  const pending = yield* SqlSchema.findAll({
    Request: UserId,
    Result: Schema.Struct({ id: TranscriptTurnId, startedAt: Schema.DateTimeUtcFromDate }),
    execute: (ownedUserId) => sql`
      SELECT id, started_at AS "startedAt" FROM conversation_turns
      WHERE user_id = ${ownedUserId} AND state = 'Pending'
      ORDER BY started_at, id FOR UPDATE
    `,
  })(userId);
  for (const turn of pending) {
    const now = yield* DateTime.now;
    const terminalAt =
      now.epochMilliseconds >= turn.startedAt.epochMilliseconds ? now : turn.startedAt;
    yield* appendEntry(
      sql,
      userId,
      InterruptedTurnTranscriptEntry.make({
        id: TranscriptEntryId.make(yield* crypto.randomUUIDv7),
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
  return pending.map((turn) => turn.id);
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

const observeOwned = Effect.fn("ConversationContinuity.observe")(function* (
  dependencies: Dependencies,
  userId: UserId
) {
  const observed = yield* inUserTransaction(
    dependencies.sql,
    userId,
    readContinuityView(dependencies.sql, userId)
  );
  return observed;
});

const prepareOwned = Effect.fn("ConversationContinuity.prepareForTurn")(function* (
  dependencies: Dependencies,
  userId: UserId
) {
  const recovered = yield* inUserTransaction(
    dependencies.sql,
    userId,
    Effect.gen(function* () {
      const recoveredTurnIds = yield* recoverPending(dependencies, userId);
      const observed = yield* observePersisted(dependencies.sql, userId);
      return { observed, recoveredTurnIds };
    })
  );
  for (const turnId of recovered.recoveredTurnIds) {
    dependencies.authorities.consumeTurnFor(userId, turnId);
  }
  return dependencies.authorities.registerPrepared(
    userId,
    recovered.observed.revision,
    recovered.observed.view
  );
});

type BeginTurnRequest = {
  readonly entry: UserTranscriptEntry;
  readonly prepared: PreparedContinuity;
  readonly userId: UserId;
};

const beginOwned = Effect.fn("ConversationContinuity.beginTurn")(function* (
  dependencies: Dependencies,
  request: BeginTurnRequest
) {
  const { authorities, sql } = dependencies;
  const authority = yield* authorities.preparedFor(request.userId, request.prepared);
  const entry = yield* Schema.decodeUnknownEffect(Schema.toType(UserTranscriptEntry))(
    request.entry
  ).pipe(Effect.mapError(() => new InvalidTranscriptEntry()));
  yield* inUserTransaction(
    sql,
    request.userId,
    Effect.gen(function* () {
      yield* ensureContinuity(sql, request.userId);
      if ((yield* readRevision(sql, request.userId, true)) !== authority.revision) {
        authorities.consumePrepared(request.prepared);
        return yield* new ContinuityChanged();
      }
      yield* sql`
        INSERT INTO conversation_turns (user_id, id, state, started_at)
        VALUES (${request.userId}, ${entry.turnId}, 'Pending', ${entry.occurredAt})
      `;
      yield* appendEntry(sql, request.userId, entry);
      yield* incrementRevision(sql, request.userId);
    })
  );
  authorities.consumePrepared(request.prepared);
  return authorities.registerTurn(request.userId, entry);
});

type AppendTurnRequest = {
  readonly entries: ReadonlyArray<TurnContinuationEntry>;
  readonly handle: TurnHandle;
  readonly userId: UserId;
};

const appendOwned = Effect.fn("ConversationContinuity.appendTurn")(function* (
  dependencies: Dependencies,
  request: AppendTurnRequest
) {
  const { authorities, sql } = dependencies;
  const authority = yield* authorities.turnFor(request.userId, request.handle);
  const entries = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.toType(TurnContinuationEntry))
  )(request.entries).pipe(Effect.mapError(() => new InvalidTranscriptEntry()));
  if (entries.some((entry) => entry.turnId !== authority.turnId)) {
    return yield* new TurnAuthorityRejected({ reason: "EntryTurnMismatch" });
  }
  yield* inUserTransaction(
    sql,
    request.userId,
    Effect.gen(function* () {
      yield* requirePending(sql, request.userId, authority.turnId);
      for (const entry of entries) yield* appendEntry(sql, request.userId, entry);
      if (entries.length > 0) yield* incrementRevision(sql, request.userId);
    })
  );
});

type TerminalEntry =
  | {
      readonly _tag: "Completed";
      readonly entry: AssistantTranscriptEntry;
    }
  | {
      readonly _tag: "Failed";
      readonly entry: FailedTurnTranscriptEntry;
      readonly reason: TurnFailureReason;
    };
type TerminalEntryFactory = (
  authority: TurnAuthority,
  terminalAt: DateTime.Utc
) => Effect.Effect<
  TerminalEntry,
  TurnAuthorityRejected | InvalidTranscriptEntry | InvalidTurnFailureReason
>;

type TerminalizeOwnedRequest = {
  readonly handle: TurnHandle;
  readonly makeEntry: TerminalEntryFactory;
  readonly terminalAt: DateTime.Utc;
  readonly userId: UserId;
};

const terminalizeOwned = Effect.fn("ConversationContinuity.terminalize")(function* (
  dependencies: Dependencies,
  request: TerminalizeOwnedRequest
) {
  const { authorities, sql } = dependencies;
  const authority = yield* authorities.turnFor(request.userId, request.handle);
  const terminalAt = yield* Schema.decodeUnknownEffect(Schema.toType(UtcTimestamp))(
    request.terminalAt
  ).pipe(Effect.mapError(() => new InvalidTerminalTimestamp()));
  if (terminalAt.epochMilliseconds < authority.startedAt.epochMilliseconds) {
    return yield* new InvalidTerminalTimestamp();
  }
  const terminal = yield* request.makeEntry(authority, terminalAt);
  yield* inUserTransaction(
    sql,
    request.userId,
    Effect.gen(function* () {
      yield* requirePending(sql, request.userId, authority.turnId);
      yield* appendEntry(sql, request.userId, terminal.entry);
      yield* sql`
        UPDATE conversation_turns
        SET state = ${terminal._tag}, terminal_at = ${terminalAt},
          failure_reason = ${terminal._tag === "Failed" ? terminal.reason : null}
        WHERE user_id = ${request.userId} AND id = ${authority.turnId} AND state = 'Pending'
      `;
      yield* incrementRevision(sql, request.userId);
    })
  );
  authorities.consumeTurn(request.handle);
});

type CompleteOwnedRequest = CompleteTurnRequest & {
  readonly handle: TurnHandle;
  readonly userId: UserId;
};

const completeOwned = Effect.fn("ConversationContinuity.completeTurn")(function* (
  dependencies: Dependencies,
  request: CompleteOwnedRequest
) {
  return yield* terminalizeOwned(dependencies, {
    handle: request.handle,
    makeEntry: (authority) =>
      Schema.decodeUnknownEffect(Schema.toType(AssistantTranscriptEntry))(request.entry).pipe(
        Effect.mapError(() => new InvalidTranscriptEntry()),
        Effect.flatMap((entry) =>
          entry.turnId === authority.turnId
            ? Effect.succeed({ _tag: "Completed" as const, entry })
            : Effect.fail(new TurnAuthorityRejected({ reason: "EntryTurnMismatch" }))
        )
      ),
    terminalAt: request.terminalAt,
    userId: request.userId,
  });
});

type FailOwnedRequest = FailTurnRequest & {
  readonly handle: TurnHandle;
  readonly userId: UserId;
};

const failOwned = Effect.fn("ConversationContinuity.failTurn")(function* (
  dependencies: Dependencies,
  request: FailOwnedRequest
) {
  return yield* terminalizeOwned(dependencies, {
    handle: request.handle,
    makeEntry: (authority, terminalAt) =>
      Schema.decodeUnknownEffect(TurnFailureReason)(request.reason).pipe(
        Effect.mapError(() => new InvalidTurnFailureReason()),
        Effect.flatMap((reason) =>
          dependencies.crypto.randomUUIDv7.pipe(
            Effect.orDie,
            Effect.map((id) => ({
              _tag: "Failed" as const,
              entry: FailedTurnTranscriptEntry.make({
                id: TranscriptEntryId.make(id),
                turnId: authority.turnId,
                reason,
                occurredAt: terminalAt,
              }),
              reason,
            }))
          )
        )
      ),
    terminalAt: request.terminalAt,
    userId: request.userId,
  });
});

// Named Effect operations expose each bounded SQL workflow as a trace span. The owning hosted-Turn
// orchestration reports failures once, so this persistence module deliberately does not log them.
const makeConversationContinuity = Effect.gen(function* () {
  const dependencies: Dependencies = {
    authorities: makeAuthorityRegistry(),
    crypto: yield* Crypto.Crypto,
    sql: yield* SqlClient.SqlClient,
  };
  return {
    observe(userId: UserId): ReturnType<typeof observeOwned> {
      return observeOwned(dependencies, userId);
    },
    prepareForTurn(userId: UserId): ReturnType<typeof prepareOwned> {
      return prepareOwned(dependencies, userId);
    },
    beginTurn(
      userId: UserId,
      prepared: PreparedContinuity,
      entry: UserTranscriptEntry
    ): ReturnType<typeof beginOwned> {
      return beginOwned(dependencies, { userId, prepared, entry });
    },
    appendTurn(
      userId: UserId,
      handle: TurnHandle,
      entries: ReadonlyArray<TurnContinuationEntry>
    ): ReturnType<typeof appendOwned> {
      return appendOwned(dependencies, { userId, handle, entries });
    },
    completeTurn(
      userId: UserId,
      handle: TurnHandle,
      request: CompleteTurnRequest
    ): ReturnType<typeof completeOwned> {
      return completeOwned(dependencies, { userId, handle, ...request });
    },
    failTurn(
      userId: UserId,
      handle: TurnHandle,
      request: FailTurnRequest
    ): ReturnType<typeof failOwned> {
      return failOwned(dependencies, { userId, handle, ...request });
    },
  };
});

type ConversationContinuityService = Effect.Success<typeof makeConversationContinuity>;

/**
 * Owns exact Transcript admission, explicit Turn lifecycle, and abandoned-Pending recovery.
 *
 * Call `prepareForTurn` before building model context; it atomically marks any durable Pending Turn
 * Interrupted and returns a single-use, User-bound revision authority. Pass that authority and the
 * exact User entry to `beginTurn`, then use its User-bound Turn handle with `appendTurn` and exactly
 * one of `completeTurn` after successful visible delivery or `failTurn` otherwise. Appends and
 * terminalization persist their entries and lifecycle
 * changes atomically; `observe` is read-only. A successful terminal operation consumes its handle.
 *
 * Callers must serialize this sequence per User because a later preparation treats an earlier Pending
 * Turn as abandoned. Invalid, foreign, forged, stale, mismatched, consumed, and already-terminal
 * authority and noncanonical entries, terminal instants, or failure reasons are reported by the
 * exported typed errors; persistence failures are defects at this shell
 * boundary. This module deliberately does not log Transcript content or canonical tool evidence.
 */
export class ConversationContinuity extends Context.Service<
  ConversationContinuity,
  ConversationContinuityService
>()("fidy-ai/shell/transcript/conversation-continuity/ConversationContinuity") {
  static readonly layer = Layer.effect(this, makeConversationContinuity);
}
