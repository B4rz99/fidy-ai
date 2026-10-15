import { Effect, Schema } from "effect";
import { RecurringDocument } from "../../../src/core/recurring-plans/contract";
import { emptyRecurringDocument } from "../../../src/core/recurring-plans/operations";
import { RecurringPlanningUnavailable } from "../contract";
import { type CanonicalPreparationWork } from "../../canonical-operations/contract";
import { callerAuthority } from "../../canonical-work/operations";

export const DocumentJson = Schema.fromJsonString(Schema.toCodecJson(RecurringDocument));
export const completion = `INSERT INTO recurring_plan_assertion (id, accepted)
  VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
  ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;
const Row = Schema.Struct({ document_json: Schema.String, revision: Schema.Int });
export const readDocument = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Effect.Effect<
  RecurringDocument,
  RecurringPlanningUnavailable
> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare("SELECT document_json, revision FROM recurring_plan_documents WHERE user_id = ?")
        .bind(userId)
        .first()
    );
    if (raw === null) {
      return yield* Schema.decodeEffect(Schema.toType(RecurringDocument))(emptyRecurringDocument());
    }
    const row = yield* Schema.decodeUnknownEffect(Row)(raw);
    const document = yield* Schema.decodeEffect(DocumentJson)(row.document_json);
    if (document.revision !== row.revision) return yield* new RecurringPlanningUnavailable();
    return document;
  }).pipe(Effect.mapError(() => new RecurringPlanningUnavailable()));
export const writeDocument = ({
  work,
  document,
  encoded,
}: Readonly<{
  work: CanonicalPreparationWork;
  document: RecurringDocument;
  encoded: string;
}>): D1PreparedStatement => {
  const authority = callerAuthority(work);
  if (document.revision === 1) {
    return work.db
      .prepare(`INSERT INTO recurring_plan_documents (user_id, document_json, revision)
    SELECT user_id, ?, 1 FROM ${authority.table} WHERE ${authority.predicate}
    ON CONFLICT(user_id) DO NOTHING`)
      .bind(encoded, ...authority.bindings);
  }
  return work.db
    .prepare(`UPDATE recurring_plan_documents SET document_json = ?, revision = ?
    WHERE user_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(
      encoded,
      document.revision,
      work.subject.userId,
      document.revision - 1,
      ...authority.bindings
    );
};
export const encodeDocument = (
  document: RecurringDocument
): Effect.Effect<string, Schema.SchemaError> => Schema.encodeUnknownEffect(DocumentJson)(document);
