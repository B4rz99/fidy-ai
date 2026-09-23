import {
  Counterparty,
  Transaction,
  TransactionId,
  TransactionPresentation,
  TransactionQueryValues,
} from "@fidy/server/transactions-runtime";
import { Clock, DateTime, Effect, Option, Schema } from "effect";

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
}));
const filters = new Set(["from", "to", "categoryId", "counterparty", "direction", "currency"]);
const maxFilters = 6;
const noStore = { "cache-control": "no-store" };
const failure = (code: string, status: number): Response =>
  Response.json(
    { error: { code, message: "Transaction unavailable." }, next: [] },
    { status, headers: noStore }
  );
const HTTP_INVALID = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHENTICATED = 401;
const invalid = (): Response => failure("validation_failed", HTTP_INVALID);
const notFound = (): Response => failure("not_found", HTTP_NOT_FOUND);
const noSession = (): Response => failure("unauthenticated", HTTP_UNAUTHENTICATED);
const unavailable = (): Response =>
  Response.json({ status: "unavailable" }, { status: 503, headers: noStore });
// @effect-diagnostics-next-line cryptoRandomUUID:off
const uuid = (): string => crypto.randomUUID();
const now = (): number => Effect.runSync(Clock.currentTimeMillis);

type Subject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;
type Selection = Readonly<{ request: Request; subject: Subject; id: Option.Option<string> }>;

const parseQuery = (selection: Selection): Option.Option<typeof Query.Type> => {
  if (
    Option.isSome(selection.id) &&
    Option.isNone(Schema.decodeOption(TransactionId)(selection.id.value))
  ) {
    return Option.none();
  }
  const params = new URL(selection.request.url).searchParams;
  if (params.size > maxFilters || [...params.keys()].some((key) => !filters.has(key))) {
    return Option.none();
  }
  return Schema.decodeOption(Query)(Object.fromEntries(params));
};

const selectStatement = (
  db: D1Database,
  args: Readonly<{ selection: Selection; query: typeof Query.Type; current: number }>
): D1PreparedStatement => {
  const { selection, query, current } = args;
  const { subject, id } = selection;
  const conditions = [
    "user_id = ?",
    `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND token_digest = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`,
  ];
  const values: Array<string | number | Uint8Array> = [
    subject.userId,
    subject.id,
    subject.userId,
    subject.digest,
    current,
    current,
  ];
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
  return db
    .prepare(
      `SELECT id, amount, currency, direction, counterparty, category_id, notes, occurred_at, created_at FROM transactions WHERE ${conditions.join(" AND ")} ORDER BY occurred_at DESC, created_at DESC, id DESC LIMIT 100`
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

const presentHistory = (rows: D1Result, id: Option.Option<string>): Response => {
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
  return Response.json(
    { data: transactions.map((transaction) => Schema.encodeSync(Output)(transaction)), next: [] },
    { headers: noStore }
  );
};

// @effect-diagnostics-next-line asyncFunction:off
const invalidQueryAudit = async (
  db: D1Database,
  selection: Selection,
  current: number
): Promise<Response> => {
  const { subject } = selection;
  try {
    const audit = await db
      .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
      SELECT ?, user_id, id, ?, 'validation_failed', ? FROM web_sessions WHERE id = ? AND user_id = ? AND token_digest = ?
      AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?`)
      .bind(
        uuid(),
        Option.isNone(selection.id)
          ? "transactions.listTransactions"
          : "transactions.getTransaction",
        current,
        subject.id,
        subject.userId,
        subject.digest,
        current,
        current
      )
      .run();
    return audit.meta.changes === 1 ? invalid() : noSession();
  } catch {
    return unavailable();
  }
};

/** Browse only the authenticated User's canonical Transactions, with one atomic metadata audit. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const browseTransactions = async (
  db: D1Database,
  selection: Selection
): Promise<Response> => {
  const query = parseQuery(selection);
  const current = now();
  const { subject } = selection;
  if (Option.isNone(query)) return invalidQueryAudit(db, selection, current);
  try {
    const [rows, audit] = await db.batch([
      selectStatement(db, { selection, query: query.value, current }),
      db
        .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
        SELECT ?, user_id, id, ?,
          CASE WHEN ? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transactions WHERE transactions.user_id = web_sessions.user_id AND transactions.id = ?)
            THEN 'not_found' ELSE 'success' END,
          ? FROM web_sessions WHERE id = ? AND user_id = ? AND token_digest = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?`)
        .bind(
          uuid(),
          Option.isNone(selection.id)
            ? "transactions.listTransactions"
            : "transactions.getTransaction",
          Option.getOrNull(selection.id),
          Option.getOrNull(selection.id),
          current,
          subject.id,
          subject.userId,
          subject.digest,
          current,
          current
        ),
    ]);
    if (audit?.meta.changes !== 1) {
      return noSession();
    }
    return rows === undefined ? unavailable() : presentHistory(rows, selection.id);
  } catch {
    return unavailable();
  }
};
