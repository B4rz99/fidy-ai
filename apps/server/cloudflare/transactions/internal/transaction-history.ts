import { SourceAttestationKind } from "../../../src/core/source-attestation/contract";
import {
  TransactionInspection,
  TransactionListResponse,
} from "../../../src/shell/transactions/contract";
import { nextTransactionPage } from "../../../src/shell/transactions/operations";
import {
  Counterparty,
  Direction,
  Transaction,
  TransactionId,
  type TransactionPresentation,
  TransactionQueryValues,
  TransactionSearchQuery,
  maximumTransactionPageSize,
} from "../../../src/core/transactions/contract";
import { Currency, encodeMoneyAmount } from "../../../src/core/_shared/money";
import {
  type effectiveHistoryPage,
  effectiveTransactionRelation,
  selectedEffectiveHistoryPage,
} from "./effective-transaction";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import { PrivacyTransactionPage } from "../../../src/shell/processing-consent/contract";
import type { PrivacyTransactionRequest } from "../../../src/shell/processing-consent/contract";
import {
  type CanonicalCaller,
  type QueryAuthority,
  missingTransactionMessage,
  transactionNoStore as noStore,
  transactionFailure,
  transactionUnavailable as unavailable,
} from "../../canonical-work/operations";

type BoundStatement = Readonly<{
  sql: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

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
  limit: Schema.OptionFromOptionalKey(fields.limit),
  from: Schema.OptionFromOptionalKey(fields.from),
  to: Schema.OptionFromOptionalKey(fields.to),
  categoryId: Schema.OptionFromOptionalKey(fields.categoryId),
  counterparty: Schema.OptionFromOptionalKey(Counterparty),
  direction: Schema.OptionFromOptionalKey(fields.direction),
  currency: Schema.OptionFromOptionalKey(fields.currency),
  amount: Schema.OptionFromOptionalKey(fields.amount),
  cursor: Schema.OptionFromOptionalKey(fields.cursor),
  q: Schema.OptionFromOptionalKey(TransactionSearchQuery.fields.q),
}));

const filters = new Set([
  "limit",
  "from",
  "to",
  "categoryId",
  "counterparty",
  "direction",
  "currency",
  "amount",
  "cursor",
]);

const maxFilters = filters.size;

const maxSearchUrlLength = 2048;

const minimumSearchLength = 2;

const pageSize = maximumTransactionPageSize;

const boundarySize = pageSize + 1;

const failure = (
  code: "unauthenticated" | "validation_failed" | "not_found" | "rate_limited",
  status: number
): Response => transactionFailure({ code, status, message: missingTransactionMessage });

const HTTP_INVALID = 400;

const HTTP_NOT_FOUND = 404;

export const invalid = (): Response => failure("validation_failed", HTTP_INVALID);

const notFound = (): Response => failure("not_found", HTTP_NOT_FOUND);

type Subject = CanonicalCaller;

type Selection = Readonly<{ request: Request; subject: Subject }> &
  (
    | Readonly<{ search: true; id: Option.Option<never> }>
    | Readonly<{ search: false; id: Option.Option<string> }>
  );

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
  params.size <= (search ? maxFilters + 1 : maxFilters) &&
  new Set(params.keys()).size === params.size &&
  [...params.keys()].every((key) => filters.has(key) || (search && key === "q"));

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

export class InvalidTransactionQuery extends Data.TaggedError("InvalidTransactionQuery") {}

const queryValuesFor = (
  selection: Pick<Selection, "id" | "request" | "search">
): Option.Option<Readonly<{ values: Record<string, string>; search: boolean }>> => {
  if (!validSelectedId(selection.id)) return Option.none();
  const search = selection.search === true;

  if (search && selection.request.url.length > maxSearchUrlLength) return Option.none();
  const url = new URL(selection.request.url);

  if (search && !validEncoding(url.search)) return Option.none();
  const params = url.searchParams;

  if (!validParameters(params, search, Option.isSome(selection.id))) return Option.none();

  return Option.map(queryValues(params, search), (values) => ({ values, search }));
};

export const parseQuery = Effect.fn(function* (
  selection: Pick<Selection, "id" | "request" | "search">
) {
  const input = queryValuesFor(selection);

  if (Option.isNone(input)) return yield* new InvalidTransactionQuery();

  const decoded = Schema.decodeOption(Query)(input.value.values);

  if (Option.isNone(decoded) || !validDecodedQuery(decoded.value, input.value.search)) {
    return yield* new InvalidTransactionQuery();
  }

  return decoded.value;
});

type AuthorityCondition = Pick<QueryAuthority, "table" | "predicate" | "bindings">;

const listFilters = ({
  userId,
  query,
  authority,
}: Readonly<{
  userId: Option.Option<string>;
  query: typeof Query.Type;
  authority: Option.Option<AuthorityCondition>;
}>): Omit<Parameters<typeof effectiveHistoryPage>[0], "userId"> => {
  const conditions = [
    ...Option.toArray(Option.map(userId, () => "user_id = ?")),
    ...Option.toArray(
      Option.map(
        authority,
        (live) => `EXISTS (SELECT 1 FROM ${live.table} WHERE ${live.predicate})`
      )
    ),
  ];

  const values: Array<string | number | Uint8Array> = [
    ...Option.toArray(userId),
    ...Option.toArray(authority).flatMap((live) => live.bindings),
  ];

  const fields: ReadonlyArray<readonly [string, Option.Option<string | number>]> = [
    ["occurred_at_ms >=", Option.map(query.from, DateTime.toEpochMillis)],
    ["occurred_at_ms <", Option.map(query.to, DateTime.toEpochMillis)],
    ["category_id =", query.categoryId],
    ["counterparty =", query.counterparty],
    ["direction =", query.direction],
    ["currency =", query.currency],
    ["amount =", Option.map(query.amount, encodeMoneyAmount)],
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

  const cursor = Option.flatMap(query.cursor, decodeCursor);

  if (Option.isSome(cursor)) {
    const [occurred, created, recordId] = cursor.value;
    conditions.push("(occurred_at_ms, created_at_ms, id) < (?, ?, ?) ");
    values.push(
      DateTime.toEpochMillis(DateTime.makeUnsafe(occurred)),
      DateTime.toEpochMillis(DateTime.makeUnsafe(created)),
      recordId
    );
  }

  return {
    where: conditions.join(" AND "),
    bindings: values,
    limit: Option.getOrElse(query.limit, () => pageSize) + 1,
  };
};

export const selectedHistoryPage = ({
  userSelection,
  query,
  authority,
}: Readonly<{
  query: typeof Query.Type;
  authority: AuthorityCondition;
  userSelection: OwnedStatement;
}>): ReturnType<typeof selectedEffectiveHistoryPage> =>
  selectedEffectiveHistoryPage({
    taxonomyRevision: true,
    userSelection,
    ...listFilters({ userId: Option.none(), query, authority: Option.some(authority) }),
  });

export const localHistoryPage = ({
  user,
  query,
}: {
  user: string;
  query: typeof Query.Type;
}): ReturnType<typeof selectedEffectiveHistoryPage> =>
  selectedEffectiveHistoryPage({
    taxonomyRevision: true,
    userSelection: { sql: "SELECT ? AS userId", params: [user] },
    ...listFilters({ userId: Option.some(user), query, authority: Option.none() }),
  });

type PresentationSelection = Readonly<{
  userId: string;
  id: string;
  authority: Option.Option<AuthorityCondition>;
}>;

const presentationGuard = (
  authority: PresentationSelection["authority"]
): Readonly<{ sql: string; bindings: ReadonlyArray<string | number | Uint8Array> }> =>
  Option.match(authority, {
    onNone: () => ({ sql: "", bindings: [] }),
    onSome: (live) => ({
      sql: ` AND EXISTS (SELECT 1 FROM ${live.table} WHERE ${live.predicate})`,
      bindings: live.bindings,
    }),
  });

const originalProjection = (member: "first" | "second"): string => `(SELECT json_object(
  'id', original.id, 'amount', original.amount, 'currency', original.currency,
  'direction', original.direction, 'counterparty', original.counterparty,
  'category_id', original.category_id, 'notes', original.notes,
  'occurred_at', strftime('%Y-%m-%dT%H:%M:%fZ',original.occurred_at_ms/1000.0,'unixepoch'),
  'created_at', strftime('%Y-%m-%dT%H:%M:%fZ',original.created_at_ms/1000.0,'unixepoch'),
  'revision', original.revision,
  'source_kinds', json((SELECT json_group_array(kind) FROM (
    SELECT DISTINCT kind FROM source_attestations attestation
    WHERE attestation.user_id = original.user_id AND attestation.transaction_id = original.id
    ORDER BY kind LIMIT 4))))
  FROM transactions original WHERE original.user_id = requested.user_id
    AND original.id = requested.reconciliation_${member}_id
    AND original.deleted_at_ms IS NULL) AS ${member}_original`;

export const presentationQuery = ({
  userId,
  id,
  authority,
}: PresentationSelection): BoundStatement => {
  const relation = effectiveTransactionRelation(userId);
  const guard = presentationGuard(authority);

  return {
    sql: `WITH readiness AS MATERIALIZED (SELECT EXISTS (
        SELECT 1 FROM transaction_projection_state
        WHERE user_id = ? AND version = 1 AND readiness = 'ready') AS available),
      ${relation.sql}, repair_presentation AS (
      SELECT effective.id, effective.amount, effective.currency,
        effective.direction, effective.counterparty, effective.category_id, effective.notes,
        effective.occurred_at, effective.created_at, requested.revision AS revision,
        requested.id AS requested_id, (linked.id IS NOT NULL) AS linked,
        ${originalProjection("first")}, ${originalProjection("second")}
      FROM transactions requested
      LEFT JOIN linked_member linked ON linked.id = requested.id
      LEFT JOIN linked_decision decision
        ON decision.first_transaction_id = linked.first_transaction_id
        AND decision.second_transaction_id = linked.second_transaction_id
      INNER JOIN effective_transaction effective
        ON effective.id = COALESCE(decision.visible_transaction_id, requested.id)
      WHERE requested.user_id = ? AND requested.id = ? AND requested.deleted_at_ms IS NULL${guard.sql}
      LIMIT CASE WHEN (SELECT available FROM readiness) THEN 0 ELSE 1 END)
      SELECT effective.id, effective.amount, effective.currency, effective.direction,
        effective.counterparty, effective.category_id, effective.notes,
        strftime('%Y-%m-%dT%H:%M:%fZ',effective.occurred_at_ms/1000.0,'unixepoch') AS occurred_at,
        strftime('%Y-%m-%dT%H:%M:%fZ',effective.created_at_ms/1000.0,'unixepoch') AS created_at,
        requested.revision AS revision, requested.id AS requested_id,
        (requested.reconciliation_first_id IS NOT NULL) AS linked,
        ${originalProjection("first")}, ${originalProjection("second")}
      FROM transactions requested
      LEFT JOIN transaction_reconciliation_decisions decision
        ON decision.user_id = requested.user_id
        AND decision.first_transaction_id = requested.reconciliation_first_id
        AND decision.second_transaction_id = requested.reconciliation_second_id
        AND decision.state = 'linked'
      INNER JOIN transaction_projection_leaf effective
        ON effective.user_id = requested.user_id
        AND effective.id = COALESCE(decision.visible_transaction_id, requested.id)
      WHERE (SELECT available FROM readiness) AND requested.user_id = ?
        AND requested.id = ? AND requested.deleted_at_ms IS NULL${guard.sql}
      UNION ALL SELECT * FROM repair_presentation`,
    bindings: [
      userId,
      ...relation.bindings,
      userId,
      id,
      ...guard.bindings,
      userId,
      id,
      ...guard.bindings,
    ],
  };
};

const storedFields = (row: typeof Row.Type): typeof Transaction.Encoded => ({
  id: row.id,
  money: { amount: row.amount, currency: row.currency },
  direction: row.direction,
  categoryId: row.category_id,
  ...Option.match(Option.fromNullOr(row.counterparty), {
    onNone: () => ({}),
    onSome: (counterparty) => ({ counterparty }),
  }),
  ...Option.match(Option.fromNullOr(row.notes), {
    onNone: () => ({}),
    onSome: (notes) => ({ notes }),
  }),
  occurredAt: row.occurred_at,
  createdAt: row.created_at,
  revision: row.revision,
});

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

export type StoredTransaction = typeof TransactionOutput.Type;

const InspectionOriginal = Schema.Struct({
  ...Row.fields,
  source_kinds: Schema.Array(SourceAttestationKind).check(Schema.isMaxLength(4)),
});

const InspectionRow = Schema.Struct({
  ...PresentationRow.fields,
  first_original: Schema.NullOr(Schema.fromJsonString(InspectionOriginal)),
  second_original: Schema.NullOr(Schema.fromJsonString(InspectionOriginal)),
});

export const decodeInspectionRow = (raw: unknown): Option.Option<TransactionInspection> => {
  const decoded = Schema.decodeUnknownOption(InspectionRow)(raw);

  if (Option.isNone(decoded)) return Option.none();
  const row = decoded.value;
  const base = { ...storedFields(row), presentation: presentationMetadata(row) };

  if (row.linked === 0) {
    return Schema.decodeOption(TransactionInspection)({
      ...base,
      reconciliation: { kind: "independent" },
      sources: [],
    });
  }

  const { first_original: first, second_original: second } = row;

  if (first === null || second === null || first.id === second.id) return Option.none();

  return Schema.decodeOption(TransactionInspection)({
    ...base,
    sources: [
      { transactionId: first.id, kinds: first.source_kinds },
      { transactionId: second.id, kinds: second.source_kinds },
    ],
    reconciliation: {
      kind: "linked",
      firstTransaction: storedFields(first),
      secondTransaction: storedFields(second),
    },
  });
};

const decodedHistoryPage = (
  rows: Readonly<{ results: ReadonlyArray<unknown> }>,
  selection: Pick<Selection, "request" | "search">,
  query: typeof Query.Type
): Option.Option<typeof TransactionListResponse.Type> => {
  const decoded = rows.results.map(decodeTransactionRow);

  if (decoded.some(Option.isNone)) {
    return Option.none();
  }

  const transactions = decoded.flatMap((item) => (Option.isSome(item) ? [item.value] : []));
  const size = Option.getOrElse(query.limit, () => pageSize);
  const visible = transactions.slice(0, size);
  const last = visible.at(-1);

  const next =
    transactions.length > size && last !== undefined
      ? nextTransactionPage({
          cursor: `${DateTime.formatIso(last.occurredAt)}|${DateTime.formatIso(last.createdAt)}|${last.id}`,
          filters: Object.fromEntries(
            [...new URL(selection.request.url).searchParams].filter(([name]) => name !== "cursor")
          ),
          operation:
            selection.search === true
              ? "transactions.searchTransactions"
              : "transactions.listTransactions",
        })
      : [];

  return Option.map(Schema.decodeOption(TransactionListResponse.fields.next)(next), (next) => ({
    data: visible,
    next,
  }));
};

export const decodeLocalHistoryPage = ({
  rows,
  selection,
  query,
}: Readonly<{
  rows: ReadonlyArray<unknown>;
  selection: Pick<Selection, "request" | "search">;
  query: typeof Query.Type;
}>): ReturnType<typeof decodedHistoryPage> =>
  decodedHistoryPage({ results: rows }, selection, query);

export const presentHistory = ({
  rows,
  selection,
  query,
}: Readonly<{
  rows: Readonly<{ results: ReadonlyArray<unknown> }>;
  selection: Pick<Selection, "id" | "request" | "search">;
  query: typeof Query.Type;
}>): Response => {
  const { id } = selection;

  if (Option.isSome(id)) {
    const first = rows.results[0];

    if (first === undefined) {
      return notFound();
    }

    const presentation = decodeInspectionRow(first);

    return Option.isNone(presentation)
      ? unavailable()
      : Response.json(
          {
            data: Schema.encodeSync(Schema.toCodecJson(TransactionInspection))(presentation.value),
            next: [],
          },
          { headers: noStore }
        );
  }

  const page = decodedHistoryPage(rows, selection, query);

  return Option.isNone(page)
    ? unavailable()
    : Response.json(
        {
          data: page.value.data.map((transaction) =>
            Schema.encodeSync(TransactionOutput)(transaction)
          ),
          next: Schema.encodeSync(TransactionListResponse.fields.next)(page.value.next),
        },
        { headers: noStore }
      );
};

export const privacyQuery = Effect.fnUntraced(function* (
  request: typeof PrivacyTransactionRequest.Type
) {
  return yield* Schema.decodeEffect(Query)(
    request.cursor === null
      ? {}
      : {
          cursor: `${DateTime.formatIso(request.cursor.occurredAt)}|${DateTime.formatIso(request.cursor.createdAt)}|${request.cursor.id}`,
        }
  );
});

export const presentPrivacyPage = ({
  rows,
  reference,
  display,
}: Readonly<{
  rows: ReadonlyArray<unknown>;
  reference: string;
  display: Pick<PrivacyTransactionPage, "presentation" | "categories">;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (rows.length > boundarySize) return unavailable();
    const decoded = Option.all(rows.map(decodeTransactionRow));

    if (Option.isNone(decoded)) return unavailable();
    const data = decoded.value.slice(0, pageSize);
    const last = data.at(-1);

    const page = yield* Schema.encodeEffect(Schema.toCodecJson(PrivacyTransactionPage))({
      reference,
      scope: "transactions",
      data,
      ...display,
      next:
        decoded.value.length > pageSize && last !== undefined
          ? { occurredAt: last.occurredAt, createdAt: last.createdAt, id: last.id }
          : null,
    });

    return Response.json(page, { headers: noStore });
  }).pipe(Effect.tapError(Effect.logDebug), Effect.orElseSucceed(unavailable));
