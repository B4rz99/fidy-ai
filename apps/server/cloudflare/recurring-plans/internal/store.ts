import {
  prepareUserDocumentWrite,
  readUserDocumentSnapshot,
} from "../../user-documents/operations";
import { Effect, Option, Schema } from "effect";
import {
  RecurringDocument,
  RecurringFulfillment,
  RecurringPlanInput,
} from "../../../src/core/recurring-plans/contract";
import { emptyRecurringDocument } from "../../../src/core/recurring-plans/operations";
import { RecurringPlanningUnavailable } from "../contract";
import { type CanonicalPreparationWork } from "../../canonical-operations/contract";
import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";

const JsonDocument = Schema.toCodecJson(RecurringDocument);
const Root = Schema.Struct({
  excludedTransactionIds: RecurringDocument.fields.excludedTransactionIds,
  suggestions: RecurringDocument.fields.suggestions,
});
const RootJson = Schema.fromJsonString(Schema.toCodecJson(Root));
const maximumChunkBytes = 900_000;
const maximumRowBytes = 1_998_976;
const JsonRow = Schema.Struct({ body: Schema.fromJsonString(Schema.Unknown) });
const rowBodies = (rows: ReadonlyArray<typeof JsonRow.Type>): ReadonlyArray<unknown> =>
  rows.map((row) => row.body);
const Plans = Schema.Struct({
  id: Schema.String,
  position: Schema.Int,
  pauses: Schema.Array(Schema.Unknown),
  stoppedOn: Schema.NullOr(Schema.String),
});
const Revisions = Schema.Struct({
  planId: Schema.String,
  position: Schema.Int,
  from: Schema.String,
  plan: Schema.Unknown,
});

const selections = [
  "SELECT json_object('id',id,'position',position,'pauses',json(pauses_json),'stoppedOn',stopped_on) AS body FROM recurring_plans WHERE user_id=? ORDER BY position LIMIT 101",
  "SELECT json_object('planId',plan_id,'position',position,'from',from_date,'plan',json(plan_json)) AS body FROM recurring_plan_revisions WHERE user_id=? ORDER BY position LIMIT 10001",
  "SELECT json_object('planId',plan_id,'date',local_date,'skipped',json(CASE skipped WHEN 1 THEN 'true' ELSE 'false' END),'replacement',json(replacement_json)) AS body FROM recurring_plan_exceptions WHERE user_id=? ORDER BY position LIMIT 4097",
  "SELECT json_object('id',id,'planId',plan_id,'date',local_date,'actualDate',actual_date,'money',json_object('amount',amount,'currency',currency),'settled',json(CASE settled WHEN 1 THEN 'true' ELSE 'false' END),'automatic',json(CASE automatic WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE NULL END),'transactionId',transaction_id) AS body FROM recurring_plan_fulfillments WHERE user_id=? ORDER BY position LIMIT 4097",
];
const ExceptionRow = Schema.Struct({
  ...RecurringDocument.fields.exceptions.value.fields,
  replacement: Schema.NullOr(Schema.toEncoded(RecurringPlanInput)),
});
const FulfillmentRow = Schema.Struct({
  ...RecurringFulfillment.fields,
  money: Schema.toEncoded(RecurringFulfillment.fields.money),
  automatic: Schema.NullOr(Schema.Boolean),
  transactionId: Schema.NullOr(Schema.String),
});

export const readDocument = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Effect.Effect<
  RecurringDocument,
  RecurringPlanningUnavailable
> =>
  Effect.gen(function* () {
    const snapshot = yield* readUserDocumentSnapshot({
      db,
      userId,
      kind: "recurring-plan",
      related: selections.map((sql) => db.prepare(sql).bind(userId)),
    });
    const rows = yield* Effect.forEach(snapshot.related, (result) =>
      Schema.decodeUnknownEffect(Schema.Array(JsonRow))(result.results).pipe(Effect.map(rowBodies))
    );
    if (Option.isNone(snapshot.document)) {
      if (rows.some((entries) => entries.length !== 0)) {
        return yield* new RecurringPlanningUnavailable();
      }
      return yield* Schema.decodeEffect(Schema.toType(RecurringDocument))(emptyRecurringDocument());
    }
    const root = yield* Schema.decodeEffect(RootJson)(snapshot.document.value.encoded, {
      onExcessProperty: "error",
    });
    const plans = yield* Schema.decodeUnknownEffect(Schema.Array(Plans))(rows[0]);
    const revisions = yield* Schema.decodeUnknownEffect(Schema.Array(Revisions))(rows[1]);
    const exceptions = yield* Schema.decodeUnknownEffect(Schema.Array(ExceptionRow))(rows[2]);
    const fulfillments = yield* Schema.decodeUnknownEffect(Schema.Array(FulfillmentRow))(rows[3]);
    return yield* Schema.decodeUnknownEffect(JsonDocument)({
      ...root,
      revision: snapshot.document.value.revision,
      plans: plans.map((plan) => ({
        id: plan.id,
        pauses: plan.pauses,
        ...(plan.stoppedOn === null ? {} : { stoppedOn: plan.stoppedOn }),
        revisions: revisions
          .filter((revision) => revision.planId === plan.id)
          .map(({ from, plan: settings }) => ({ from, plan: settings })),
      })),
      exceptions: exceptions.map(({ replacement, ...entry }) => ({
        ...entry,
        ...(replacement === null ? {} : { replacement }),
      })),
      fulfillments: fulfillments.map(({ automatic, transactionId, ...entry }) => ({
        ...entry,
        ...(automatic === null ? {} : { automatic }),
        ...(transactionId === null ? {} : { transactionId }),
      })),
    });
  }).pipe(Effect.mapError(() => new RecurringPlanningUnavailable()));

type EncodedDocument = typeof RecurringDocument.Encoded;
type StoredRow = Readonly<{ key: string; encoded: string }>;
type Collection = Readonly<{
  table: string;
  columns: string;
  values: string;
  key: string;
  rows: (document: EncodedDocument) => ReadonlyArray<StoredRow>;
}>;
const row = (key: string, value: object): StoredRow => ({
  key,
  encoded: Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value),
});
const collections: ReadonlyArray<Collection> = [
  {
    table: "recurring_plans",
    columns: "id,position,pauses_json,stopped_on",
    values:
      "json_extract(value,'$.id'),json_extract(value,'$.position'),json_extract(value,'$.pauses'),json_extract(value,'$.stoppedOn')",
    key: "id",
    rows: (document) =>
      document.plans.map(({ id, pauses, stoppedOn }, position) =>
        row(id, { id, pauses, stoppedOn, position })
      ),
  },
  {
    table: "recurring_plan_revisions",
    columns: "plan_id,position,from_date,plan_json",
    values:
      "json_extract(value,'$.planId'),json_extract(value,'$.position'),json_extract(value,'$.from'),json_extract(value,'$.plan')",
    key: "plan_id||':'||from_date",
    rows: (document) =>
      document.plans.flatMap((plan) =>
        plan.revisions.map((revision, position) =>
          row(plan.id + ":" + revision.from, { ...revision, planId: plan.id, position })
        )
      ),
  },
  {
    table: "recurring_plan_exceptions",
    columns: "plan_id,position,local_date,skipped,replacement_json",
    values:
      "json_extract(value,'$.planId'),json_extract(value,'$.position'),json_extract(value,'$.date'),json_extract(value,'$.skipped'),json_extract(value,'$.replacement')",
    key: "plan_id||':'||local_date",
    rows: (document) =>
      document.exceptions.map((entry, position) =>
        row(entry.planId + ":" + entry.date, { ...entry, position })
      ),
  },
  {
    table: "recurring_plan_fulfillments",
    columns:
      "id,plan_id,position,local_date,actual_date,amount,currency,settled,automatic,transaction_id",
    values:
      "json_extract(value,'$.id'),json_extract(value,'$.planId'),json_extract(value,'$.position'),json_extract(value,'$.date'),json_extract(value,'$.actualDate'),json_extract(value,'$.money.amount'),json_extract(value,'$.money.currency'),json_extract(value,'$.settled'),json_extract(value,'$.automatic'),json_extract(value,'$.transactionId')",
    key: "id",
    rows: (document) =>
      document.fulfillments.map((entry, position) => row(entry.id, { ...entry, position })),
  },
];
const chunks = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const result: string[] = [];
  let pending: string[] = [];
  let bytes = 2;
  for (const value of values) {
    const size = new TextEncoder().encode(value).length + 1;
    if (size > maximumRowBytes) throw new RecurringPlanningUnavailable();
    if (pending.length > 0 && bytes + size > maximumChunkBytes) {
      result.push("[" + pending.join(",") + "]");
      pending = [];
      bytes = 2;
    }
    pending.push(value);
    bytes += size;
  }
  if (pending.length > 0) result.push("[" + pending.join(",") + "]");
  return result;
};
const collectionWrites = (
  work: CanonicalPreparationWork,
  collection: Collection,
  documents: Readonly<{ before: EncodedDocument; after: EncodedDocument }>
): ReadonlyArray<D1PreparedStatement> => {
  const statements: D1PreparedStatement[] = [];
  const oldRows = new Map(
    collection.rows(documents.before).map((entry) => [entry.key, entry.encoded])
  );
  const nextRows = collection.rows(documents.after);
  const nextKeys = new Set(nextRows.map((entry) => entry.key));
  const removed = [...oldRows.keys()].filter((key) => !nextKeys.has(key));
  for (const keys of chunks(
    removed.map((key) => Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(key))
  )) {
    statements.push(
      work.db
        .prepare(
          `DELETE FROM ${collection.table} WHERE user_id=? AND ${collection.key} IN(SELECT value FROM json_each(?))`
        )
        .bind(work.subject.userId, keys)
    );
  }
  for (const changed of chunks(
    nextRows
      .filter((entry) => oldRows.get(entry.key) !== entry.encoded)
      .map((entry) => entry.encoded)
  )) {
    const updates = collection.columns
      .split(",")
      .map((column) => `${column}=excluded.${column}`)
      .join(",");
    statements.push(
      work.db
        .prepare(
          `INSERT INTO ${collection.table}(user_id,${collection.columns}) SELECT ?,${collection.values} FROM json_each(?) WHERE true ON CONFLICT DO UPDATE SET ${updates}`
        )
        .bind(work.subject.userId, changed)
    );
  }
  return statements;
};

export const writeDocument = ({
  work,
  base,
  document,
}: Readonly<{
  work: CanonicalPreparationWork;
  base: RecurringDocument;
  document: RecurringDocument;
}>): Effect.Effect<ReadonlyArray<D1PreparedStatement>, RecurringPlanningUnavailable> =>
  Effect.gen(function* () {
    const before = yield* Schema.encodeEffect(RecurringDocument)(base);
    const after = yield* Schema.encodeEffect(RecurringDocument)(document);
    const encoded = yield* Schema.encodeEffect(RootJson)(document);
    return yield* Effect.try({
      try: () => {
        const statements: D1PreparedStatement[] = [
          prepareUserDocumentWrite({
            work,
            kind: "recurring-plan",
            encoded,
            revision: document.revision,
          }),
          prepareChangedRowAssertion({ db: work.db, scope: "recurring_plan" }),
        ];
        for (const collection of collections) {
          statements.push(...collectionWrites(work, collection, { before, after }));
        }
        return statements;
      },
      catch: () => new RecurringPlanningUnavailable(),
    });
  }).pipe(Effect.mapError(() => new RecurringPlanningUnavailable()));
