import { nextTransactionPage } from "@fidy/server/transaction-continuation";
import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import {
  Counterparty,
  Currency,
  Direction,
  Transaction,
  TransactionId,
  TransactionPresentation,
  TransactionQueryValues,
  TransactionSearchQuery,
} from "@fidy/server/transactions-runtime";
import { effectiveTransactionRelation } from "./effective-transaction";
import { DateTime, Option, Schema } from "effect";
import type { AuthorizedPAT } from "../pats/pat-authorization";
import {
  livePATAuthority,
  recordCanonicalPATWork,
  recordLivePATUse,
} from "@fidy/server/tokens-runtime";
import { refusedByAuditBudget } from "../audit/audit-triggers";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  type TransactionAuthority,
  type TransactionCaller,
  type TransactionSubject,
  isPATCaller,
  missingTransactionMessage,
  transactionNoStore as noStore,
  transactionNow as now,
  refusedPATWork,
  transactionAuditExhausted,
  transactionFailure,
  transactionUnavailable as unavailable,
  transactionId as uuid,
} from "./transaction-boundary";

/** The canonical stored-Transaction encoding every Transaction adapter returns. */
export const TransactionOutput = Schema.toCodecJson(Transaction);
const Row = Schema.Struct({
  id: TransactionId,
  amount: Schema.String,
  currency: Currency,
  direction: Direction,
  counterparty: Schema.NullOr(Schema.String),
  category_id: Schema.String,
  notes: Schema.NullOr(Schema.String),
  occurred_at: Schema.String,
  created_at: Schema.String,
  revision: Schema.Int,
});
const Query = TransactionQueryValues.mapFields((fields) => ({
  from: Schema.OptionFromOptionalKey(fields.from),
  to: Schema.OptionFromOptionalKey(fields.to),
  categoryId: Schema.OptionFromOptionalKey(fields.categoryId),
  counterparty: Schema.OptionFromOptionalKey(Counterparty),
  direction: Schema.OptionFromOptionalKey(fields.direction),
  currency: Schema.OptionFromOptionalKey(fields.currency),
  cursor: Schema.OptionFromOptionalKey(fields.cursor),
  q: Schema.OptionFromOptionalKey(TransactionSearchQuery.fields.q),
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
const maxSearchUrlLength = 2048;
const minimumSearchLength = 2;
const pageSize = 100;
const boundarySize = pageSize + 1;
const failure = (
  code: "unauthenticated" | "validation_failed" | "not_found" | "rate_limited",
  status: number
): Response => transactionFailure({ code, status, message: missingTransactionMessage });
const HTTP_INVALID = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHENTICATED = 401;
const HTTP_RATE_LIMITED = 429;
const invalid = (): Response => failure("validation_failed", HTTP_INVALID);
const notFound = (): Response => failure("not_found", HTTP_NOT_FOUND);
const rateLimited = (): Response => failure("rate_limited", HTTP_RATE_LIMITED);
const noSession = (): Response => failure("unauthenticated", HTTP_UNAUTHENTICATED);
const failedAudit = (error: unknown): Response =>
  refusedByAuditBudget(error) ? rateLimited() : unavailable();
type Subject = TransactionCaller;
type Selection = Readonly<{ request: Request; subject: Subject }> &
  (
    | Readonly<{ search: true; id: Option.Option<never> }>
    // History callers select a single record by id or list when id is absent.
    | Readonly<{ search: false; id: Option.Option<string> }>
  );
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

const searchValues = (values: Record<string, string>): Option.Option<Record<string, string>> => {
  const parsed = Schema.decodeUnknownOption(TransactionSearchQuery)(values);
  if (Option.isNone(parsed)) return Option.none();
  const term = parsed.value.q.trim().replace(/\s+/gu, " ");
  return term.length < minimumSearchLength ? Option.none() : Option.some({ ...values, q: term });
};

const validEncoding = (query: string): boolean => {
  try {
    decodeURIComponent(query);
    return true;
  } catch {
    return false;
  }
};

const validParameters = (params: URLSearchParams, search: boolean, hasId: boolean): boolean =>
  !(hasId && params.size > 0) &&
  params.size <= (search ? minimumSearchLength : maxFilters) &&
  new Set(params.keys()).size === params.size &&
  [...params.keys()].every((key) => (search ? key === "q" || key === "cursor" : filters.has(key)));

const historyOperation = (
  selection: Pick<Selection, "id" | "search">
):
  | "transactions.getTransaction"
  | "transactions.listTransactions"
  | "transactions.searchTransactions" => {
  if (Option.isSome(selection.id)) return "transactions.getTransaction";
  return selection.search === true
    ? "transactions.searchTransactions"
    : "transactions.listTransactions";
};

const queryValues = (
  params: URLSearchParams,
  search: boolean
): Option.Option<Record<string, string>> => {
  const values = Object.fromEntries(params);
  return search ? searchValues(values) : Option.some(values);
};

const validSelectedId = (id: Option.Option<string>): boolean =>
  Option.isNone(id) || Option.isSome(Schema.decodeOption(TransactionId)(id.value));

const validDecodedQuery = (query: typeof Query.Type, search: boolean): boolean =>
  (search ? Option.isSome(query.q) : Option.isNone(query.q)) &&
  (Option.isNone(query.cursor) || Option.isSome(decodeCursor(query.cursor.value)));

const parseQuery = (
  selection: Pick<Selection, "id" | "request" | "search">
): Option.Option<typeof Query.Type> => {
  if (!validSelectedId(selection.id)) return Option.none();
  const search = selection.search === true;
  if (search && selection.request.url.length > maxSearchUrlLength) return Option.none();
  const url = new URL(selection.request.url);
  if (search && !validEncoding(url.search)) return Option.none();
  const params = url.searchParams;
  if (!validParameters(params, search, Option.isSome(selection.id))) return Option.none();
  const values = queryValues(params, search);
  if (Option.isNone(values)) return Option.none();
  const decoded = Schema.decodeOption(Query)(values.value);
  return Option.filter(decoded, (query) => validDecodedQuery(query, search));
};

type AuthorityCondition = Pick<TransactionAuthority, "table" | "predicate" | "bindings">;
type HistoryRow = Readonly<{
  db: D1Database;
  userId: string;
  query: typeof Query.Type;
  authority: AuthorityCondition;
}>;

/**
 * One bounded effective-history page for the caller. Filters and the keyset cursor apply to the
 * effective Transaction, so a linked pair is filtered and paged as the one record it represents.
 */
const listStatement = ({ db, userId, query, authority }: HistoryRow): D1PreparedStatement => {
  const relation = effectiveTransactionRelation(userId);
  const conditions = [
    "user_id = ?",
    `EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`,
  ];
  const values: Array<string | number | Uint8Array> = [
    ...relation.bindings,
    userId,
    ...authority.bindings,
  ];
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
  if (Option.isSome(query.q)) {
    conditions.push(
      "(instr(lower(counterparty), lower(?)) > 0 OR instr(lower(notes), lower(?)) > 0)"
    );
    values.push(query.q.value, query.q.value);
  }
  if (Option.isSome(query.cursor)) {
    const [occurred, created, recordId] = Option.getOrThrow(decodeCursor(query.cursor.value));
    conditions.push("(occurred_at, created_at, id) < (?, ?, ?)");
    values.push(occurred, created, recordId);
  }
  return db
    .prepare(
      `WITH ${relation.sql} SELECT id, amount, currency, direction, counterparty, category_id, notes, occurred_at, created_at, revision FROM effective_transaction WHERE ${conditions.join(" AND ")} ORDER BY occurred_at DESC, created_at DESC, id DESC LIMIT ${boundarySize}`
    )
    .bind(...values);
};

type PresentationSelection = Readonly<{
  db: D1Database;
  userId: string;
  id: string;
  authority: Option.Option<AuthorityCondition>;
}>;

/**
 * One effective presentation by either original id, optionally gated on a live caller authority.
 * A linked member resolves to the effective Transaction and records which original id was requested.
 * `revision` is the requested member's, so the value a caller reads for an id is exactly the value
 * its correction compare-and-swaps.
 */
const presentationStatement = ({
  db,
  userId,
  id,
  authority,
}: PresentationSelection): D1PreparedStatement => {
  const relation = effectiveTransactionRelation(userId);
  const guard: Readonly<{
    sql: string;
    bindings: ReadonlyArray<string | number | Uint8Array>;
  }> = Option.match(authority, {
    onNone: () => ({ sql: "", bindings: [] }),
    onSome: (live) => ({
      sql: ` AND EXISTS (SELECT 1 FROM ${live.table} WHERE ${live.predicate})`,
      bindings: live.bindings,
    }),
  });
  return db
    .prepare(
      `WITH ${relation.sql} SELECT effective.id, effective.amount, effective.currency,
        effective.direction, effective.counterparty, effective.category_id, effective.notes,
        effective.occurred_at, effective.created_at, requested.revision AS revision,
        requested.id AS requested_id, (linked.id IS NOT NULL) AS linked
      FROM transactions requested
      LEFT JOIN linked_member linked ON linked.id = requested.id
      LEFT JOIN linked_decision decision
        ON decision.first_transaction_id = linked.first_transaction_id
        AND decision.second_transaction_id = linked.second_transaction_id
      INNER JOIN effective_transaction effective
        ON effective.id = COALESCE(decision.visible_transaction_id, requested.id)
      WHERE requested.user_id = ? AND requested.id = ?${guard.sql}`
    )
    .bind(...relation.bindings, userId, id, ...guard.bindings);
};

const storedFields = (row: typeof Row.Type): typeof Transaction.Encoded => ({
  id: row.id,
  money: { amount: row.amount, currency: row.currency },
  direction: row.direction,
  categoryId: row.category_id,
  ...(row.counterparty === null ? {} : { counterparty: row.counterparty }),
  ...(row.notes === null ? {} : { notes: row.notes }),
  occurredAt: row.occurred_at,
  createdAt: row.created_at,
  revision: row.revision,
});

/** Decode untrusted D1 projection into the canonical Transaction shape before it may be returned. */
export const decodeTransactionRow = (
  raw: unknown
): Option.Option<typeof TransactionOutput.Type> => {
  const row = Schema.decodeUnknownOption(Row)(raw);
  return Option.isNone(row)
    ? Option.none()
    : Schema.decodeOption(TransactionOutput)(storedFields(row.value));
};

const PresentationRow = Schema.Struct({
  ...Row.fields,
  requested_id: TransactionId,
  linked: Schema.Literals([0, 1]),
});

type PresentationMetadata = TransactionPresentation["presentation"];

const presentationMetadata = (row: typeof PresentationRow.Type): PresentationMetadata => {
  if (row.linked === 0) return { kind: "independent" };
  if (row.requested_id === row.id) return { kind: "visible-member" };
  return { kind: "suppressed-member", requestedId: row.requested_id };
};

/** Decode one effective projection and explain how the requested id maps to its visible identity. */
const decodePresentationRow = (raw: unknown): Option.Option<TransactionPresentation> => {
  const row = Schema.decodeUnknownOption(PresentationRow)(raw);
  if (Option.isNone(row)) return Option.none();
  return Schema.decodeOption(TransactionPresentation)({
    ...storedFields(row.value),
    presentation: presentationMetadata(row.value),
  });
};

/** A stored Transaction decoded into the canonical JSON projection every response carries. */
export type StoredTransaction = typeof TransactionOutput.Type;

/** Read one owned Transaction projection by id; absence is an answer rather than a defect. */
export const findTransaction = ({
  db,
  userId,
  id,
}: Readonly<{ db: D1Database; userId: string; id: string }>): Promise<
  Option.Option<StoredTransaction>
> =>
  db
    .prepare(`SELECT id, amount, currency, direction, counterparty, category_id, notes, occurred_at, created_at, revision
      FROM transactions WHERE user_id = ? AND id = ?`)
    .bind(userId, id)
    .first()
    .then(decodeTransactionRow);

/** Read one effective presentation by either original id, as an immediate canonical read would. */
export const findTransactionPresentation = ({
  db,
  userId,
  id,
}: Readonly<{ db: D1Database; userId: string; id: string }>): Promise<
  Option.Option<TransactionPresentation>
> =>
  presentationStatement({ db, userId, id, authority: Option.none() })
    .first()
    .then(decodePresentationRow);

const presentHistory = (
  rows: D1Result,
  selection: Pick<Selection, "id" | "request" | "search">
): Response => {
  const { id, request } = selection;
  if (Option.isSome(id)) {
    const first = rows.results[0];
    if (first === undefined) {
      return notFound();
    }
    const presentation = decodePresentationRow(first);
    return Option.isNone(presentation)
      ? unavailable()
      : Response.json(
          {
            data: Schema.encodeSync(Schema.toCodecJson(TransactionPresentation))(
              presentation.value
            ),
            next: [],
          },
          { headers: noStore }
        );
  }
  const decoded = rows.results.map(decodeTransactionRow);
  if (decoded.some(Option.isNone)) {
    return unavailable();
  }
  const transactions = decoded.flatMap((item) => (Option.isSome(item) ? [item.value] : []));
  const visible = transactions.slice(0, pageSize);
  const last = visible.at(-1);
  const next =
    transactions.length > pageSize && last !== undefined
      ? nextTransactionPage(
          `${DateTime.formatIso(last.occurredAt)}|${DateTime.formatIso(last.createdAt)}|${last.id}`,
          Object.fromEntries(
            [...new URL(request.url).searchParams].filter(([name]) => name !== "cursor")
          ),
          selection.search === true
            ? "transactions.searchTransactions"
            : "transactions.listTransactions"
        )
      : [];
  return Response.json(
    { data: visible.map((transaction) => Schema.encodeSync(TransactionOutput)(transaction)), next },
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
          historyOperation(selection),
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

const historyStatement = (
  input: Readonly<{
    db: D1Database;
    selection: Selection;
    query: typeof Query.Type;
    authority: AuthorityCondition;
  }>
): D1PreparedStatement => {
  const { db, selection, query, authority } = input;
  const userId = selection.subject.userId;
  return Option.isSome(selection.id)
    ? presentationStatement({
        db,
        userId,
        id: selection.id.value,
        authority: Option.some(authority),
      })
    : listStatement({ db, userId, query, authority });
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
    historyStatement({
      db,
      selection,
      query,
      authority,
    }),
    db
      .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
        SELECT ?, user_id, id, ?,
          CASE WHEN ? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transactions WHERE transactions.user_id = web_sessions.user_id AND transactions.id = ?)
            THEN 'not_found' ELSE 'success' END,
          ? FROM ${authority.table} WHERE ${authority.predicate}`)
      .bind(
        uuid(),
        historyOperation(selection),
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
  const { subject } = selection;
  const authority = livePATAuthority({ subject, current });
  return [
    prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
    ...(Option.isSome(query)
      ? [
          historyStatement({
            db,
            selection,
            query: query.value,
            authority,
          }),
        ]
      : []),
    prepareOwnedStatement({
      db,
      statement: recordCanonicalPATWork({
        subject,
        input: {
          id: uuid(),
          operation: historyOperation(selection),
          outcome: Option.isSome(query) ? "accepted" : "rejected",
          afterOwnerWrite: false,
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
  if (isPATCaller(subject)) {
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
  if (Option.isNone(query) && !isPATCaller(subject)) {
    return invalidQueryAudit(db, { ...selection, subject }, current);
  }
  return transactionAuditExhausted({ db, userId: subject.userId, current })
    .then((exhausted) =>
      exhausted ? rateLimited() : readAuthorizedHistory(db, { selection, query, current })
    )
    .catch(failedAudit);
};
