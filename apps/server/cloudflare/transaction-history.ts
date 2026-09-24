import { nextTransactionPage } from "@fidy/server/transaction-continuation";
import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import {
  Counterparty,
  Transaction,
  TransactionId,
  TransactionPresentation,
  TransactionQueryValues,
} from "@fidy/server/transactions-runtime";
import { DateTime, Option, Schema } from "effect";
import type { AuthorizedPAT } from "./pat-authorization";
import {
  livePATAuthority,
  recordCanonicalPATWork,
  recordLivePATUse,
} from "@fidy/server/tokens-runtime";
import { prepareOwnedStatement } from "./pat-unit";
import {
  type TransactionSubject,
  transactionNoStore as noStore,
  transactionNow as now,
  refusedPATWork,
  transactionAuditExhausted,
  transactionFailure,
  transactionUnavailable as unavailable,
  transactionId as uuid,
} from "./transaction-boundary";

const Output = Schema.toCodecJson(Transaction);
const Row = Schema.Struct({
  id: TransactionId,
  amount: Schema.String,
  currency: Schema.String,
  direction: Schema.String,
  counterparty: Schema.NullOr(Schema.String),
  category_id: Schema.String,
  notes: Schema.NullOr(Schema.String),
  occurred_at: Schema.String,
  created_at: Schema.String,
});
const Query = TransactionQueryValues.mapFields((fields) => ({
  from: Schema.OptionFromOptionalKey(fields.from),
  to: Schema.OptionFromOptionalKey(fields.to),
  categoryId: Schema.OptionFromOptionalKey(fields.categoryId),
  counterparty: Schema.OptionFromOptionalKey(Counterparty),
  direction: Schema.OptionFromOptionalKey(fields.direction),
  currency: Schema.OptionFromOptionalKey(fields.currency),
  cursor: Schema.OptionFromOptionalKey(fields.cursor),
}));
const filters = new Set([
  "from",
  "to",
  "categoryId",
  "counterparty",
  "direction",
  "currency",
  "cursor",
]);
const maxFilters = 7;
const pageSize = 100;
const boundarySize = pageSize + 1;
const failure = (
  code: "unauthenticated" | "validation_failed" | "not_found" | "rate_limited",
  status: number
): Response => transactionFailure({ code, status, message: "Transaction unavailable." });
const HTTP_INVALID = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHENTICATED = 401;
const HTTP_RATE_LIMITED = 429;
const invalid = (): Response => failure("validation_failed", HTTP_INVALID);
const notFound = (): Response => failure("not_found", HTTP_NOT_FOUND);
const rateLimited = (): Response => failure("rate_limited", HTTP_RATE_LIMITED);
const noSession = (): Response => failure("unauthenticated", HTTP_UNAUTHENTICATED);
const failedAudit = (error: unknown): Response =>
  String(error).includes("transaction_audit_limit") ? rateLimited() : unavailable();
type Subject = TransactionSubject | AuthorizedPAT;
const isPAT = (subject: Subject): subject is AuthorizedPAT => "patId" in subject;
type Selection = Readonly<{ request: Request; subject: Subject; id: Option.Option<string> }>;
type BrowserSelection = Selection & Readonly<{ subject: TransactionSubject }>;

const decodeCursor = (cursor: string): Option.Option<readonly [string, string, string]> => {
  const pieces = Schema.decodeUnknownOption(
    Schema.Tuple([Schema.String, Schema.String, TransactionId])
  )(cursor.split("|"));
  if (Option.isNone(pieces)) return Option.none();
  const [occurred, created] = pieces.value;
  return Option.isSome(DateTime.make(occurred)) && Option.isSome(DateTime.make(created))
    ? Option.some(pieces.value)
    : Option.none();
};

const parseQuery = (
  selection: Pick<Selection, "id" | "request">
): Option.Option<typeof Query.Type> => {
  if (
    Option.isSome(selection.id) &&
    Option.isNone(Schema.decodeOption(TransactionId)(selection.id.value))
  ) {
    return Option.none();
  }
  const params = new URL(selection.request.url).searchParams;
  if (
    (Option.isSome(selection.id) && params.size > 0) ||
    params.size > maxFilters ||
    [...params.keys()].some((key) => !filters.has(key))
  ) {
    return Option.none();
  }
  return Option.filter(
    Schema.decodeOption(Query)(Object.fromEntries(params)),
    (query) => Option.isNone(query.cursor) || Option.isSome(decodeCursor(query.cursor.value))
  );
};

type AuthorityCondition = Readonly<{
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;
const selectStatement = (
  db: D1Database,
  args: Readonly<{
    selection: Pick<Selection, "id">;
    query: typeof Query.Type;
    authority: AuthorityCondition;
  }>
): D1PreparedStatement => {
  const { selection, query, authority } = args;
  const { id } = selection;
  const conditions = ["user_id = ?", authority.predicate];
  const values: Array<string | number | Uint8Array> = [...authority.bindings];
  if (Option.isSome(id)) {
    conditions.push("id = ?");
    values.push(id.value);
  }
  const fields = [
    ["occurred_at >=", Option.map(query.from, DateTime.formatIso)],
    ["occurred_at <", Option.map(query.to, DateTime.formatIso)],
    ["category_id =", query.categoryId],
    ["counterparty =", query.counterparty],
    ["direction =", query.direction],
    ["currency =", query.currency],
  ] as const;
  for (const [column, value] of fields) {
    if (Option.isSome(value)) {
      conditions.push(`${column} ?`);
      values.push(value.value);
    }
  }
  if (Option.isSome(query.cursor)) {
    const [occurred, created, recordId] = Option.getOrThrow(decodeCursor(query.cursor.value));
    conditions.push("(occurred_at, created_at, id) < (?, ?, ?)");
    values.push(occurred, created, recordId);
  }
  return db
    .prepare(
      `SELECT id, amount, currency, direction, counterparty, category_id, notes, occurred_at, created_at FROM transactions WHERE ${conditions.join(" AND ")} ORDER BY occurred_at DESC, created_at DESC, id DESC LIMIT ${boundarySize}`
    )
    .bind(...values);
};

/** Decode untrusted D1 projection into the canonical Transaction shape before it may be returned. */
export const decodeTransactionRow = (raw: unknown): Option.Option<typeof Output.Type> => {
  const row = Schema.decodeUnknownOption(Row)(raw);
  if (Option.isNone(row)) {
    return Option.none();
  }
  return Schema.decodeOption(Output)({
    id: row.value.id,
    money: { amount: row.value.amount, currency: row.value.currency },
    direction: row.value.direction,
    categoryId: row.value.category_id,
    ...(row.value.counterparty === null ? {} : { counterparty: row.value.counterparty }),
    ...(row.value.notes === null ? {} : { notes: row.value.notes }),
    occurredAt: row.value.occurred_at,
    createdAt: row.value.created_at,
  });
};

const presentHistory = (rows: D1Result, selection: Pick<Selection, "id" | "request">): Response => {
  const { id, request } = selection;
  const decoded = rows.results.map(decodeTransactionRow);
  if (decoded.some(Option.isNone)) {
    return unavailable();
  }
  const transactions = decoded.flatMap((item) => (Option.isSome(item) ? [item.value] : []));
  if (Option.isSome(id) && transactions.length === 0) {
    return notFound();
  }
  if (Option.isSome(id)) {
    const first = transactions[0];
    if (first === undefined) {
      return notFound();
    }
    const data = Schema.encodeSync(Schema.toCodecJson(TransactionPresentation))({
      ...first,
      presentation: { kind: "independent" },
    });
    return Response.json({ data, next: [] }, { headers: noStore });
  }
  const visible = transactions.slice(0, pageSize);
  const last = visible.at(-1);
  const next =
    transactions.length > pageSize && last !== undefined
      ? nextTransactionPage(
          `${DateTime.formatIso(last.occurredAt)}|${DateTime.formatIso(last.createdAt)}|${last.id}`,
          Object.fromEntries(
            [...new URL(request.url).searchParams].filter(([name]) => name !== "cursor")
          )
        )
      : [];
  return Response.json(
    { data: visible.map((transaction) => Schema.encodeSync(Output)(transaction)), next },
    { headers: noStore }
  );
};

const invalidQueryAudit = (
  db: D1Database,
  selection: BrowserSelection,
  current: number
): Promise<Response> => {
  const { subject } = selection;
  const invalidGet = Option.isSome(selection.id);
  return transactionAuditExhausted({ db, userId: subject.userId, current })
    .then((exhausted) => {
      if (exhausted) return rateLimited();
      const authority = liveWebSessionAuthority({ subject, current });
      return db
        .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
      SELECT ?, user_id, id, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}`)
        .bind(
          uuid(),
          invalidGet ? "transactions.getTransaction" : "transactions.listTransactions",
          invalidGet ? "not_found" : "validation_failed",
          current,
          ...authority.bindings
        )
        .run()
        .then((audit) => {
          if (audit.meta.changes !== 1) return noSession();
          return invalidGet ? notFound() : invalid();
        });
    })
    .catch(failedAudit);
};

/** Assemble a WebSession's protected read and its Transaction-owner audit. */
const browserHistoryStatements = (
  db: D1Database,
  input: Readonly<{ selection: BrowserSelection; query: typeof Query.Type; current: number }>
): Array<D1PreparedStatement> => {
  const { selection, query, current } = input;
  const { subject } = selection;
  const authority = liveWebSessionAuthority({ subject, current });
  return [
    selectStatement(db, {
      selection,
      query,
      authority: {
        predicate: `EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`,
        bindings: [subject.userId, ...authority.bindings],
      },
    }),
    db
      .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
        SELECT ?, user_id, id, ?,
          CASE WHEN ? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transactions WHERE transactions.user_id = web_sessions.user_id AND transactions.id = ?)
            THEN 'not_found' ELSE 'success' END,
          ? FROM ${authority.table} WHERE ${authority.predicate}`)
      .bind(
        uuid(),
        Option.isNone(selection.id)
          ? "transactions.listTransactions"
          : "transactions.getTransaction",
        Option.getOrNull(selection.id),
        Option.getOrNull(selection.id),
        current,
        ...authority.bindings
      ),
  ];
};

type PATSelection = Selection & Readonly<{ subject: AuthorizedPAT }>;

const patHistoryStatements = (
  db: D1Database,
  input: Readonly<{
    selection: PATSelection;
    query: Option.Option<typeof Query.Type>;
    current: number;
  }>
): Array<D1PreparedStatement> => {
  const { selection, query, current } = input;
  const { subject, id } = selection;
  const authority = livePATAuthority({ subject, current });
  return [
    prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
    ...(Option.isSome(query)
      ? [
          selectStatement(db, {
            selection,
            query: query.value,
            authority: {
              predicate: `EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`,
              bindings: [subject.userId, ...authority.bindings],
            },
          }),
        ]
      : []),
    prepareOwnedStatement({
      db,
      statement: recordCanonicalPATWork({
        subject,
        input: {
          id: uuid(),
          operation: Option.isNone(id)
            ? "transactions.listTransactions"
            : "transactions.getTransaction",
          outcome: Option.isSome(query) ? "accepted" : "rejected",
          afterSourceAttestation: false,
          current,
        },
      }),
    }),
  ];
};

const presentPATHistory = (
  input: Readonly<{
    db: D1Database;
    results: ReadonlyArray<D1Result>;
    selection: PATSelection;
    query: Option.Option<typeof Query.Type>;
  }>
): Promise<Response> => {
  const { db, results, selection, query } = input;
  if (results[0]?.meta.changes !== 1 || results.at(-1)?.meta.changes !== 1) {
    return refusedPATWork({ db, userId: selection.subject.userId });
  }
  if (Option.isNone(query)) {
    return Promise.resolve(Option.isSome(selection.id) ? notFound() : invalid());
  }
  const rows = results[1];
  return Promise.resolve(rows === undefined ? unavailable() : presentHistory(rows, selection));
};

const readAuthorizedHistory = (
  db: D1Database,
  input: Readonly<{
    selection: Selection;
    query: Option.Option<typeof Query.Type>;
    current: number;
  }>
): Promise<Response> => {
  const { selection, query, current } = input;
  const { subject } = selection;
  if (isPAT(subject)) {
    const patSelection = { ...selection, subject };
    return db
      .batch(patHistoryStatements(db, { selection: patSelection, query, current }))
      .then((results) => presentPATHistory({ db, results, selection: patSelection, query }));
  }
  if (Option.isNone(query)) return Promise.resolve(invalid());
  return db
    .batch(
      browserHistoryStatements(db, {
        selection: { ...selection, subject },
        query: query.value,
        current,
      })
    )
    .then(([rows, audit]) => {
      if (audit?.meta.changes !== 1) return noSession();
      return rows === undefined ? unavailable() : presentHistory(rows, selection);
    });
};

/** Browse the same bounded canonical Transaction projection under live WebSession or PAT authority. */
export const browseTransactions = ({
  db,
  selection,
}: {
  db: D1Database;
  selection: Selection;
}): Promise<Response> => {
  const query = parseQuery(selection);
  const current = now();
  const { subject } = selection;
  if (Option.isNone(query) && !isPAT(subject)) {
    return invalidQueryAudit(db, { ...selection, subject }, current);
  }
  return transactionAuditExhausted({ db, userId: subject.userId, current })
    .then((exhausted) =>
      exhausted ? rateLimited() : readAuthorizedHistory(db, { selection, query, current })
    )
    .catch(failedAudit);
};
