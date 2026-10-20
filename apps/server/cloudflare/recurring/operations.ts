import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import { RecurringConfirmationId } from "../../src/core/recurring/contract";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";

import {
  findRecurringSnapshot,
  prepareFactRevisionProjection,
  prepareRecurringFactGuard,
} from "../transactions/operations";

import { type QueryCaller, childCaller } from "../canonical-work/operations";
import {
  type RecurringConfirmationPage,
  type RecurringDigestSourcePage,
  RecurringUnavailable,
  maximumDigestCheckpointLength,
} from "./contract";
import { Progress, StringRow, pageSize } from "./internal/models";
import { protectConsentStatement } from "../../src/shell/consent/operations";

import {
  batch,
  cutover,
  decode,
  initialize,
  processGroup,
  query,
  scan,
} from "./internal/evaluation";
import { Cursor, Row, consentGuard, decodeRow, evaluationGuard } from "./internal/confirmations";
import {
  Cursor as QueryCursor,
  invalidCursor,
  maximumCursorLength,
  readPage,
} from "./internal/query";
import { prepareSourceGuard, readSource } from "./internal/digest-source";

type Work = Readonly<{ db: D1Database; userId: UserId }>;

/** Traverse one complete revision-bounded confirmation cutoff. Invalidations and legacy exclusions remain explicit; a changed cutoff fails closed and requires restarting traversal. */
export const readRecurringDigestSource = (
  input: Work & Readonly<{ cursor: Option.Option<string> }>
): Effect.Effect<RecurringDigestSourcePage, RecurringUnavailable> =>
  Effect.gen(function* () {
    const page = yield* readSource(input);
    for (const confirmation of page.confirmations) {
      if (Option.isNone(confirmation.snapshot)) continue;
      const snapshot = confirmation.snapshot.value;
      if (
        snapshot.userId !== input.userId ||
        snapshot.occurrence.id !== confirmation.id ||
        snapshot.occurrence.confirmedAt.epochMilliseconds !==
          confirmation.confirmedAt.epochMilliseconds
      ) {
        return yield* new RecurringUnavailable();
      }
    }
    return page;
  });

/** Compose the exact cutoff's live processing, fact-revision and complete-evaluation guards with the consumer's own atomic commit. This does not inspect or authorize consumer state. */
export const prepareRecurringDigestSourceGuard = (
  input: Work & Readonly<{ checkpoint: string }>
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, RecurringUnavailable> =>
  Effect.gen(function* () {
    if (input.checkpoint.length > maximumDigestCheckpointLength) {
      return yield* new RecurringUnavailable();
    }
    return yield* prepareSourceGuard(input);
  });

/** Advance one bounded evaluation step under this User's existing coordinator and live processing Consent. */
export const evaluateRecurringSeries = (work: Work): Effect.Effect<void, RecurringUnavailable> =>
  Effect.gen(function* () {
    const snapshot = yield* findRecurringSnapshot(work);
    if (Option.isNone(snapshot)) return yield* new RecurringUnavailable();
    const rows = yield* query({
      db: work.db,
      sql: "SELECT revision, phase, cursor_at, cursor_id, group_key, evaluated_at, first_captured_at, time_zone FROM recurring_progress WHERE user_id = ?",
      values: [work.userId],
    });
    const first = rows[0];
    if (first === undefined) return yield* initialize({ work, snapshot: snapshot.value });
    const progress = yield* decode({ schema: Progress, input: first });
    if (progress.revision !== snapshot.value.revision) {
      return yield* initialize({ work, snapshot: snapshot.value });
    }
    if (progress.phase === "scan") return yield* scan({ work, progress });
    if (progress.phase === "complete") return;
    const groups = yield* query({
      db: work.db,
      sql: "SELECT group_key AS value FROM recurring_facts WHERE user_id = ? AND group_key > ? GROUP BY group_key ORDER BY group_key LIMIT 1",
      values: [work.userId, progress.group_key],
    });
    const group = groups[0];
    if (group === undefined) return yield* cutover({ work, progress });
    return yield* processGroup({
      work,
      progress,
      group: (yield* decode({ schema: StringRow, input: group })).value,
    });
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));

const recurringWeekMs = 604800000;
const recurringDiscoveryIntervalMs = 3600000;
const recurringWorkBatchSize = 4;
const DiscoverySchedule = Schema.Struct({ next_discovery_at_ms: Schema.Int });
const discoveryOrder = `ORDER BY (userId > (SELECT last_user FROM recurring_dispatch WHERE id=1)) DESC,userId LIMIT ${recurringWorkBatchSize}`;
const discoveryStatement = ({
  db,
  current,
  discover,
}: Readonly<{ db: D1Database; current: number; discover: boolean }>): D1PreparedStatement =>
  discover
    ? prepareFactRevisionProjection({
        db,
        statement: {
          sql: `SELECT f.userId FROM transaction_fact_revisions f LEFT JOIN recurring_progress p ON p.user_id=f.userId
          WHERE p.user_id IS NULL OR p.phase<>'complete'
          OR (p.revision<>f.revision AND (p.evaluated_at IS NULL OR p.evaluated_at<=?)) ${discoveryOrder}`,
          params: [DateTime.formatIso(DateTime.makeUnsafe(current - recurringWeekMs))],
        },
      })
    : db.prepare(
        `SELECT user_id AS userId FROM recurring_progress WHERE phase<>'complete' ${discoveryOrder}`
      );
const discoveryCheckpoint = ({
  db,
  current,
  discover,
  users,
}: Readonly<{
  db: D1Database;
  current: number;
  discover: boolean;
  users: ReadonlyArray<UserId>;
}>): ReadonlyArray<D1PreparedStatement> => {
  const last = users.at(-1);
  if (discover) {
    // A full batch may leave a backlog. Keep discovering until a shorter batch drains it.
    return [
      db
        .prepare(`INSERT INTO recurring_dispatch(id,last_user,next_discovery_at_ms)
      VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET
      last_user=CASE WHEN ? IS NULL THEN recurring_dispatch.last_user ELSE excluded.last_user END,
      next_discovery_at_ms=excluded.next_discovery_at_ms`)
        .bind(
          last ?? "",
          users.length === recurringWorkBatchSize ? 0 : current + recurringDiscoveryIntervalMs,
          last ?? null
        ),
    ];
  }
  return last === undefined
    ? []
    : [db.prepare("UPDATE recurring_dispatch SET last_user=? WHERE id=1").bind(last)];
};

/** Discover changed Users at most weekly, with hourly idle discovery. Resume unfinished work and drain a full batch promptly; recheck processing authority inside each coordinator. */
export const discoverRecurringWork = (
  db: D1Database
): Effect.Effect<ReadonlyArray<UserId>, RecurringUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const schedule = yield* query({
      db,
      sql: "SELECT next_discovery_at_ms FROM recurring_dispatch WHERE id=1",
      values: [],
    });
    const stored = schedule[0];
    const discover =
      stored === undefined ||
      (yield* decode({ schema: DiscoverySchedule, input: stored })).next_discovery_at_ms <= current;
    const result = yield* Effect.tryPromise({
      try: () => discoveryStatement({ db, current, discover }).all(),
      catch: () => new RecurringUnavailable(),
    });
    const rows = yield* decode({
      schema: Schema.Array(Schema.Struct({ userId: UserId })),
      input: result.results,
    });
    const users = rows.map((row) => row.userId);
    const statements = discoveryCheckpoint({ db, current, discover, users });
    if (statements.length > 0) yield* batch({ db, statements });
    return users;
  });

/** Read immutable confirmation snapshots under current Consent inside this User's coordinator; invalid patterns are excluded. */
export const readRecurringConfirmations = ({
  db,
  userId,
  cursor,
}: Readonly<{ db: D1Database; userId: UserId; cursor: Option.Option<string> }>): Effect.Effect<
  RecurringConfirmationPage,
  RecurringUnavailable
> =>
  Effect.gen(function* () {
    const snapshot = yield* findRecurringSnapshot({ db, userId });
    const position = Option.isSome(cursor)
      ? yield* Schema.decodeEffect(Schema.fromJsonString(Cursor))(cursor.value).pipe(Effect.asSome)
      : Option.none<typeof Cursor.Type>();
    const after = Option.match(position, {
      onNone: () => ["", ""],
      onSome: (value) => [DateTime.formatIso(value.confirmedAt), value.id],
    });
    const protectedRead = protectConsentStatement({
      subject: { _tag: "User", userId },
      requirement: "active",
      statement: {
        sql: `SELECT confirmation_id AS id, confirmation_context_json AS context_json, confirmation_json FROM recurring_series WHERE user_id = ? AND ? = 1 AND valid = 1 AND confirmation_id IS NOT NULL AND json_type(confirmation_json,'$.counterparty') IS NOT NULL AND (confirmed_at, confirmation_id) > (?, ?)`,
        params: [userId, Option.isSome(snapshot) ? 1 : 0, ...after],
      },
    });
    const raw = yield* Effect.tryPromise({
      try: () =>
        db.batch([
          consentGuard({ db, userId }),
          ...Option.match(snapshot, {
            onNone: () => [],
            onSome: (value) => [
              prepareRecurringFactGuard({ db, userId, revision: value.revision }),
              evaluationGuard({ db, userId, revision: value.revision }),
            ],
          }),
          db
            .prepare(
              `${protectedRead.sql} ORDER BY confirmed_at, confirmation_id LIMIT ${pageSize + 1}`
            )
            .bind(...protectedRead.params),
        ]),
      catch: () => new RecurringUnavailable(),
    });
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(raw.at(-1)?.results);
    const confirmations = yield* Effect.forEach(rows.slice(0, pageSize), (row) =>
      decodeRow({ row, userId })
    );
    const last = confirmations.at(-1);
    const nextCursor =
      rows.length > pageSize && last !== undefined
        ? Option.some(
            yield* Schema.encodeEffect(Schema.fromJsonString(Cursor))({
              confirmedAt: last.occurrence.confirmedAt,
              id: last.occurrence.id,
            })
          )
        : Option.none<string>();
    return { confirmations, cursor: nextCursor };
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));

/** Execute the Free read-scoped query with atomic live credential, Consent, Audit and decoded page status. */
export const listRecurringSeries = ({
  db,
  subject,
  request,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  request: Request;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const call = {
      db,
      subject: childCaller({ subject, requiredScope: Option.some("read") }),
      current: DateTime.toEpochMillis(yield* DateTime.now),
      accepted: true,
    };
    const raw = new URL(request.url).searchParams.get("cursor");
    if (raw === null) return yield* readPage({ call, cursor: Option.none() });
    if (raw.length > maximumCursorLength) return yield* invalidCursor(call);
    const cursor = Schema.decodeOption(Schema.fromJsonString(QueryCursor))(raw);
    return yield* Option.isNone(cursor) ? invalidCursor(call) : readPage({ call, cursor });
  });

/** First retained discovery, including suppressed or legacy evidence, supplies only an opt-in opportunity identity. It never grants delivery or substitutes financial snapshots. */
export const findRecurringDiscovery = (
  input: Work
): Effect.Effect<Option.Option<RecurringConfirmationId>, RecurringUnavailable> =>
  Effect.gen(function* () {
    const protectedRead = protectConsentStatement({
      subject: { _tag: "User", userId: input.userId },
      requirement: "active",
      statement: {
        sql: "SELECT confirmation_id AS id FROM recurring_series WHERE user_id=? AND confirmation_id IS NOT NULL ORDER BY confirmed_at,confirmation_id LIMIT 1",
        params: [input.userId],
      },
    });
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(protectedRead.sql)
        .bind(...protectedRead.params)
        .first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: RecurringConfirmationId }))(
      raw
    );
    return Option.some(row.id);
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));

/** Metadata-only complete evaluation identities for fair digest discovery; no financial content or execution authority is projected. */
export const recurringDigestSourceIdentities = (): OwnedStatement => ({
  sql: "SELECT p.user_id,p.evaluated_revision||':'||p.evaluated_at||':'||(SELECT coalesce(max(confirmation_sequence),0) FROM recurring_series WHERE user_id=p.user_id AND confirmation_sequence IS NOT NULL)||':'||(SELECT count(*) FROM recurring_series WHERE user_id=p.user_id AND confirmation_sequence IS NOT NULL) AS source_identity FROM recurring_progress AS p WHERE p.phase='complete'",
  params: [],
});

/** A planning decision may reference only this User's retained detector series. */
export const ownsRecurringSeries = ({
  db,
  userId,
  seriesId,
}: Readonly<{
  db: D1Database;
  userId: string;
  seriesId: string;
}>): Effect.Effect<boolean> =>
  Effect.tryPromise(() =>
    db
      .prepare("SELECT 1 FROM recurring_series WHERE user_id = ? AND id = ?")
      .bind(userId, seriesId)
      .first()
  ).pipe(
    Effect.map((row) => row !== null),
    Effect.orElseSucceed(() => false)
  );
