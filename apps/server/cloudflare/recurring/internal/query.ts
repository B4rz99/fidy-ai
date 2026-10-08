import { Data, Effect, Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { Currency } from "../../../src/core/_shared/money";
import {
  RecurringSeries,
  RecurringSeriesId,
  RecurringSeriesPage,
} from "../../../src/core/recurring/contract";
import {
  findRecurringSnapshot,
  prepareFactRevisionProjection,
  prepareRecurringFactGuard,
} from "../../transactions/operations";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import {
  type QueryCaller,
  callerAuthority,
  isPATCaller,
  transactionFailure,
  transactionId,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { RecurringUnavailable } from "../contract";
import { pageSize } from "./models";

export const maximumCursorLength = 1024;
export const Cursor = Schema.Struct({
  currency: Currency,
  key: Schema.String.check(Schema.isMaxLength(maximumCursorLength)),
  id: RecurringSeriesId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
});
const Status = Schema.Struct({
  factRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  evaluatedRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  phase: Schema.NullOr(Schema.Literals(["scan", "detect", "complete"])),
  evaluatedAt: Schema.OptionFromNullOr(RecurringSeries.fields.confirmedAt),
});
const Row = Schema.Struct({
  currency: Currency,
  counterparty_key: Schema.String,
  id: RecurringSeriesId,
  series_json: Schema.String,
});
type Call = Readonly<{
  db: D1Database;
  subject: QueryCaller;
  current: number;
  accepted: boolean;
}>;
const auditStatements = ({
  db,
  subject,
  current,
  accepted,
}: Call): ReadonlyArray<D1PreparedStatement> => {
  const authority = callerAuthority({ subject, current });
  const outcome = accepted ? "accepted" : "rejected";
  let audit: D1PreparedStatement;
  if (isPATCaller(subject)) {
    const auditStatement = recordCanonicalPATWork({
      authority: livePATAuthority({ subject, current }),
      input: {
        id: transactionId(),
        operation: "recurring.listRecurringSeries",
        current,
        outcome,
        afterOwnerWrite: false,
      },
    });
    audit = db.prepare(auditStatement.sql).bind(...auditStatement.params);
  } else {
    audit = prepareAuthorizedAuditCall({
      db,
      authority,
      id: transactionId(),
      operation: "recurring.listRecurringSeries",
      current,
      outcome,
      afterOwnerWrite: false,
    });
  }
  return [
    ...(isPATCaller(subject)
      ? [recordLivePATUse({ subject, current })].map(({ sql, params }) =>
          db.prepare(sql).bind(...params)
        )
      : []),
    audit,
    db
      .prepare(
        `INSERT INTO recurring_assertion (id, accepted) VALUES (1, CASE WHEN changes() = 1 AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}) THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`
      )
      .bind(...authority.bindings),
  ];
};
export const invalidCursor = (call: Call): Effect.Effect<Response> =>
  Effect.tryPromise(() => call.db.batch([...auditStatements({ ...call, accepted: false })])).pipe(
    Effect.map(() =>
      transactionFailure({
        code: "validation_failed",
        status: 400,
        message: "Invalid recurring-series cursor.",
      })
    ),
    Effect.orElseSucceed(transactionUnavailable)
  );
const statusOf = (
  status: Option.Option<typeof Status.Type>
): (typeof RecurringSeriesPage.Type)["evaluation"] => {
  if (Option.isNone(status) || status.value.evaluatedRevision === null) {
    return { kind: "not-evaluated" };
  }
  if (
    status.value.factRevision !== status.value.evaluatedRevision ||
    status.value.phase !== "complete"
  ) {
    return { kind: "updating" };
  }
  return Option.match(status.value.evaluatedAt, {
    onNone: () => ({ kind: "updating" }) as const,
    onSome: (asOf) => ({ kind: "current", asOf }) as const,
  });
};
class RecurringCursorChanged extends Data.TaggedError("RecurringCursorChanged") {}
const statusResultPosition = -2;
const readStatus = (
  raw: unknown
): Effect.Effect<Option.Option<typeof Status.Type>, Schema.SchemaError> =>
  raw === undefined
    ? Effect.succeedNone
    : Schema.decodeUnknownEffect(Status)(raw).pipe(Effect.asSome);
const pageResponse = ({
  raw,
  status,
}: Readonly<{ raw: unknown; status: Option.Option<typeof Status.Type> }>): Effect.Effect<
  Response,
  Schema.SchemaError
> =>
  Effect.gen(function* () {
    const revision = Option.map(status, (value) => value.evaluatedRevision ?? value.factRevision);
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(raw);
    const series = yield* Effect.forEach(rows.slice(0, pageSize), (row) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(RecurringSeries)))(
        row.series_json
      )
    );
    const last = rows.slice(0, pageSize).at(-1);
    const nextCursor =
      rows.length > pageSize && last !== undefined && Option.isSome(revision)
        ? Option.some(
            yield* Schema.encodeEffect(Schema.fromJsonString(Cursor))({
              currency: last.currency,
              key: last.counterparty_key,
              id: last.id,
              revision: revision.value,
            })
          )
        : Option.none<string>();
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(RecurringSeriesPage))({
      series,
      evaluation: statusOf(status),
      cursor: nextCursor,
    });
    return Response.json({ data, next: [] }, { headers: { "cache-control": "no-store" } });
  });
const pageStatements = (
  call: Call,
  cursor: Option.Option<typeof Cursor.Type>
): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject } = call;
  const authority = callerAuthority({ subject, current: call.current });
  const position = Option.match(cursor, {
    onNone: () => ["", "", ""],
    onSome: (value) => [value.currency, value.key, value.id],
  });
  return [
    prepareFactRevisionProjection({
      db,
      statement: {
        sql: `SELECT f.revision AS factRevision, p.evaluated_revision AS evaluatedRevision, p.phase, p.evaluated_at AS evaluatedAt FROM transaction_fact_revisions f LEFT JOIN recurring_progress p ON p.user_id = f.userId WHERE f.userId = ?`,
        params: [subject.userId],
      },
    }),
    db
      .prepare(
        `SELECT currency, counterparty_key, id, series_json FROM recurring_series WHERE user_id = ? AND valid = 1 AND (currency, counterparty_key, id) > (?, ?, ?) AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}) ORDER BY currency, counterparty_key, id LIMIT ${pageSize + 1}`
      )
      .bind(subject.userId, ...position, ...authority.bindings),
  ];
};
const revisionAssertion = (
  db: D1Database,
  userId: QueryCaller["userId"],
  revision: number
): D1PreparedStatement =>
  db
    .prepare(
      "INSERT OR REPLACE INTO recurring_cursor_assertion (id, expected_revision, current_revision) VALUES (1, ?, COALESCE((SELECT evaluated_revision FROM recurring_progress WHERE user_id = ?), 0))"
    )
    .bind(revision, userId);
export const readPage = ({
  call,
  cursor,
}: Readonly<{ call: Call; cursor: Option.Option<typeof Cursor.Type> }>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { db, subject } = call;
    const userId = yield* Schema.decodeEffect(UserId)(subject.userId);
    const snapshot = yield* findRecurringSnapshot({ db, userId });
    const results = yield* Effect.tryPromise({
      try: () => db.batch([...pageStatements(call, cursor)]),
      catch: () => new RecurringUnavailable(),
    });
    const status = yield* readStatus(results.at(statusResultPosition)?.results[0]);
    const revision = Option.match(status, {
      onNone: () => 0,
      onSome: (value) => value.evaluatedRevision ?? 0,
    });
    if (Option.isSome(cursor) && cursor.value.revision !== revision) {
      return yield* new RecurringCursorChanged();
    }
    const response = yield* pageResponse({ raw: results.at(-1)?.results, status });
    yield* Effect.tryPromise({
      try: () =>
        db.batch([
          ...Option.toArray(
            Option.map(snapshot, (value) =>
              prepareRecurringFactGuard({ db, userId, revision: value.revision })
            )
          ),
          revisionAssertion(db, subject.userId, revision),
          ...auditStatements(call),
        ]),
      catch: (cause) =>
        String(cause).includes("recurring_cursor_changed")
          ? new RecurringCursorChanged()
          : new RecurringUnavailable(),
    });
    return response;
  }).pipe(
    Effect.catchTag("RecurringCursorChanged", () => invalidCursor(call)),
    Effect.orElseSucceed(transactionUnavailable)
  );
