import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { type DateTime, Effect, Option, Schema } from "effect";
import {
  RecurringDocument,
  RecurringFulfillment,
  RecurringPlanInput,
  type RecurringSchedule,
} from "../../../src/core/recurring-plans/contract";
import { RecurringPlanningUnavailable } from "../contract";

import { displayDocument } from "./display";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

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
  pauses: Schema.Array(Schema.Json),
  stoppedOn: Schema.OptionFromNullOr(Schema.String),
});

const Revisions = Schema.Struct({
  planId: Schema.String,
  position: Schema.Int,
  from: Schema.String,
  plan: Schema.Json,
});

const selections = [
  "SELECT json_object('id',id,'position',position,'pauses',json(pauses_json),'stoppedOn',stopped_on) AS body FROM recurring_plans WHERE user_id=? ORDER BY position LIMIT 101",
  "SELECT json_object('planId',plan_id,'position',position,'from',from_date,'plan',json(plan_json)) AS body FROM recurring_plan_revisions WHERE user_id=? ORDER BY position LIMIT 10001",
  "SELECT json_object('planId',plan_id,'date',local_date,'skipped',json(CASE skipped WHEN 1 THEN 'true' ELSE 'false' END),'replacement',json(replacement_json)) AS body FROM recurring_plan_exceptions WHERE user_id=? ORDER BY position LIMIT 4097",
  "SELECT json_object('id',id,'planId',plan_id,'date',local_date,'actualDate',actual_date,'money',json_object('amount',amount,'currency',currency),'settled',json(CASE settled WHEN 1 THEN 'true' ELSE 'false' END),'automatic',json(CASE automatic WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE NULL END),'transactionId',transaction_id) AS body FROM recurring_plan_fulfillments WHERE user_id=? ORDER BY position LIMIT 4097",
];

const ExceptionRow = Schema.Struct({
  ...RecurringDocument.fields.exceptions.value.fields,
  replacement: Schema.OptionFromNullOr(Schema.toEncoded(RecurringPlanInput)),
});

const FulfillmentRow = Schema.Struct({
  ...RecurringFulfillment.fields,
  money: Schema.toEncoded(RecurringFulfillment.fields.money),
  automatic: Schema.OptionFromNullOr(Schema.Boolean),
  transactionId: Schema.OptionFromNullOr(Schema.String),
});

type PlanningRows = Readonly<{
  revision: number;
  root: typeof Root.Type;
  plans: ReadonlyArray<typeof Plans.Type>;
  revisions: ReadonlyArray<typeof Revisions.Type>;
  exceptions: ReadonlyArray<typeof ExceptionRow.Type>;
  fulfillments: ReadonlyArray<typeof FulfillmentRow.Type>;
}>;

type StoredSelection = Readonly<{
  document: Option.Option<Readonly<{ encoded: string; revision: number }>>;
  related: ReadonlyArray<Readonly<{ results: ReadonlyArray<unknown> }>>;
}>;

const decodeRows = (
  snapshot: StoredSelection
): Effect.Effect<PlanningRows, RecurringPlanningUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* Effect.forEach(snapshot.related, (result) =>
      Schema.decodeUnknownEffect(Schema.Array(JsonRow))(result.results).pipe(Effect.map(rowBodies))
    );

    if (Option.isNone(snapshot.document)) {
      if (rows.some((entries) => entries.length !== 0)) {
        return yield* new RecurringPlanningUnavailable({ cause: Option.none() });
      }

      return {
        revision: 0,
        root: { excludedTransactionIds: [], suggestions: [] },
        plans: [],
        revisions: [],
        exceptions: [],
        fulfillments: [],
      };
    }

    return {
      revision: snapshot.document.value.revision,
      root: yield* Schema.decodeEffect(RootJson)(snapshot.document.value.encoded, {
        onExcessProperty: "error",
      }),
      plans: yield* Schema.decodeUnknownEffect(Schema.Array(Plans))(rows[0]),
      revisions: yield* Schema.decodeUnknownEffect(Schema.Array(Revisions))(rows[1]),
      exceptions: yield* Schema.decodeUnknownEffect(Schema.Array(ExceptionRow))(rows[2]),
      fulfillments: yield* Schema.decodeUnknownEffect(Schema.Array(FulfillmentRow))(rows[3]),
    };
  }).pipe(
    Effect.mapError((cause) => new RecurringPlanningUnavailable({ cause: Option.some(cause) }))
  );

const planningValue = (rows: PlanningRows): Schema.Json => {
  const revisions = Map.groupBy(rows.revisions, (revision) => revision.planId);

  return {
    ...rows.root,
    revision: rows.revision,
    plans: rows.plans.map((plan) => ({
      id: plan.id,
      pauses: plan.pauses,
      ...Option.match(plan.stoppedOn, {
        onNone: () => ({}),
        onSome: (stoppedOn) => ({ stoppedOn }),
      }),
      revisions: (revisions.get(plan.id) ?? []).map(({ from, plan: settings }) => ({
        from,
        plan: settings,
      })),
    })),
    exceptions: rows.exceptions.map(({ replacement, ...entry }) => ({
      ...entry,
      ...Option.match(replacement, {
        onNone: () => ({}),
        onSome: (present) => ({ replacement: present }),
      }),
    })),
    fulfillments: rows.fulfillments.map(({ automatic, transactionId, ...entry }) => ({
      ...entry,
      ...Option.match(automatic, {
        onNone: () => ({}),
        onSome: (present) => ({ automatic: present }),
      }),
      ...Option.match(transactionId, {
        onNone: () => ({}),
        onSome: (present) => ({ transactionId: present }),
      }),
    })),
  };
};

const decodeDocument = (
  snapshot: StoredSelection
): Effect.Effect<RecurringDocument, RecurringPlanningUnavailable> =>
  decodeRows(snapshot).pipe(
    Effect.flatMap((rows) => Schema.decodeEffect(JsonDocument)(planningValue(rows))),
    Effect.mapError((cause) => new RecurringPlanningUnavailable({ cause: Option.some(cause) }))
  );

export const decodeReadProjection = ({
  rows,
  now,
}: Readonly<{ rows: PlanningRows; now: DateTime.Utc }>): Effect.Effect<
  Readonly<{
    schedule: RecurringSchedule;
    editing: RecurringDocument;
  }>,
  RecurringPlanningUnavailable
> =>
  Effect.gen(function* () {
    const schedule = yield* Schema.decodeEffect(
      Schema.toCodecJson(
        Schema.Struct({
          plans: RecurringDocument.fields.plans,
          exceptions: RecurringDocument.fields.exceptions,
          fulfillments: RecurringDocument.fields.fulfillments,
          excludedTransactionIds: RecurringDocument.fields.excludedTransactionIds,
        })
      )
    )(planningValue(rows));

    const editing = yield* Schema.decodeEffect(Schema.toType(RecurringDocument))({
      ...rows.root,
      ...schedule,
      revision: rows.revision,
      plans: schedule.plans,
    });

    return { editing: displayDocument({ document: editing, compact: true, now }), schedule };
  }).pipe(
    Effect.mapError((cause) => new RecurringPlanningUnavailable({ cause: Option.some(cause) }))
  );

type EncodedDocument = typeof RecurringDocument.Encoded;

type StoredRow = Readonly<{ key: string; encoded: string }>;

type Collection = Readonly<{
  table: string;
  columns: string;
  values: string;
  key: string;
  rows: (document: EncodedDocument) => ReadonlyArray<StoredRow>;
}>;

const row = <Row>(key: string, value: Row): StoredRow => ({
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

    if (size > maximumRowBytes) throw new RecurringPlanningUnavailable({ cause: Option.none() });

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
  user: string,
  collection: Collection,
  documents: Readonly<{ before: EncodedDocument; after: EncodedDocument }>
): ReadonlyArray<OwnedStatement> => {
  const statements: OwnedStatement[] = [];

  const oldRows = new Map(
    collection.rows(documents.before).map((entry) => [entry.key, entry.encoded])
  );

  const nextRows = collection.rows(documents.after);
  const nextKeys = new Set(nextRows.map((entry) => entry.key));
  const removed = [...oldRows.keys()].filter((key) => !nextKeys.has(key));

  for (const keys of chunks(
    removed.map((key) => Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(key))
  )) {
    statements.push({
      sql: `DELETE FROM ${collection.table} WHERE user_id=? AND ${collection.key} IN(SELECT value FROM json_each(?))`,
      params: [user, keys],
    });
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

    statements.push({
      sql: `INSERT INTO ${collection.table}(user_id,${collection.columns}) SELECT ?,${collection.values} FROM json_each(?) WHERE true ON CONFLICT DO UPDATE SET ${updates}`,
      params: [user, changed],
    });
  }

  return statements;
};

const LocalRoot = Schema.Struct({ encoded: Schema.String, revision: Schema.Int });

const localStoredSelection = Effect.fn(function* (
  user: string,
  revisions: Option.Option<OwnedStatement>
) {
  const sql = yield* SqliteClient;

  const [root] =
    yield* sql`SELECT document_json AS encoded, revision FROM user_documents WHERE user_id=${user} AND kind='recurring-plan'`;

  const document =
    root === undefined
      ? Option.none()
      : Option.some(yield* Schema.decodeUnknownEffect(LocalRoot)(root));

  const related = yield* Effect.forEach(selections, (selection, index) => {
    const query =
      index === 1 && Option.isSome(revisions)
        ? revisions.value
        : { sql: selection, params: [user] };

    return sql.unsafe(query.sql, query.params).pipe(Effect.map((results) => ({ results })));
  });

  return { document, related };
});

export const readLocalDocument = Effect.fn(function* (user: string) {
  return yield* decodeDocument(yield* localStoredSelection(user, Option.none()));
});

export const readLocalCompactProjection = Effect.fn(function* (
  user: string,
  revisions: OwnedStatement,
  now: DateTime.Utc
) {
  const rows = yield* decodeRows(yield* localStoredSelection(user, Option.some(revisions)));

  return yield* decodeReadProjection({ rows, now });
});

export const writeLocalDocument = Effect.fn(function* (
  user: string,
  base: RecurringDocument,
  document: RecurringDocument
) {
  const sql = yield* SqliteClient;
  const root = yield* Schema.encodeEffect(RootJson)(document);

  const stored =
    yield* sql`INSERT INTO user_documents(user_id,kind,document_json,revision) VALUES(${user},'recurring-plan',${root},${document.revision})
    ON CONFLICT(user_id,kind) DO UPDATE SET document_json=excluded.document_json,revision=excluded.revision WHERE revision=${base.revision} RETURNING revision`;

  if (stored.length !== 1) return yield* new RecurringPlanningUnavailable({ cause: Option.none() });
  const before = yield* Schema.encodeEffect(RecurringDocument)(base);
  const after = yield* Schema.encodeEffect(RecurringDocument)(document);

  yield* Effect.forEach(
    collections.flatMap((collection) => collectionWrites(user, collection, { before, after })),
    (statement) => sql.unsafe(statement.sql, statement.params),
    { discard: true }
  );
});
