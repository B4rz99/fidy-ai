import { DateTime, Effect, Option, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";

import {
  findRecurringSnapshot,
  prepareFactRevisionProjection,
  prepareRecurringFactGuard,
} from "../transactions/operations";

import { type QueryCaller, childCaller } from "../canonical-work/operations";
import { type RecurringConfirmationPage, RecurringUnavailable } from "./contract";
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

type Work = Readonly<{ db: D1Database; userId: UserId }>;

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

/** Discover at most four pending User identities; recheck authority inside each coordinator before reading facts. */
export const discoverRecurringWork = (
  db: D1Database
): Effect.Effect<ReadonlyArray<UserId>, RecurringUnavailable> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        prepareFactRevisionProjection({
          db,
          statement: {
            sql: `SELECT f.userId FROM transaction_fact_revisions f LEFT JOIN recurring_progress p ON p.user_id = f.userId WHERE p.revision IS NULL OR p.revision <> f.revision OR p.phase <> 'complete' ORDER BY (f.userId > (SELECT last_user FROM recurring_dispatch WHERE id = 1)) DESC, f.userId LIMIT 4`,
            params: [],
          },
        }).all(),
      catch: () => new RecurringUnavailable(),
    });
    const rows = yield* decode({
      schema: Schema.Array(Schema.Struct({ userId: UserId })),
      input: result.results,
    });
    const last = rows.at(-1);
    if (last !== undefined) {
      yield* batch({
        db,
        statements: [
          db.prepare("UPDATE recurring_dispatch SET last_user = ? WHERE id = 1").bind(last.userId),
        ],
      });
    }
    return rows.map((row) => row.userId);
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
        sql: `SELECT c.id, c.context_json, c.confirmation_json FROM recurring_confirmations c JOIN recurring_series s ON s.user_id = c.user_id AND s.id = c.series_id WHERE c.user_id = ? AND ? = 1 AND s.valid = 1 AND (c.confirmed_at, c.id) > (?, ?)`,
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
            .prepare(`${protectedRead.sql} ORDER BY c.confirmed_at, c.id LIMIT ${pageSize + 1}`)
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
