import { findUserDocument, prepareUserDocumentWrite } from "../../user-documents/operations";
import { Effect, Option, Schema } from "effect";
import { RecurringDocument } from "../../../src/core/recurring-plans/contract";
import { emptyRecurringDocument } from "../../../src/core/recurring-plans/operations";
import { RecurringPlanningUnavailable } from "../contract";
import { type CanonicalPreparationWork } from "../../canonical-operations/contract";

export const DocumentJson = Schema.fromJsonString(Schema.toCodecJson(RecurringDocument));

export const readDocument = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Effect.Effect<
  RecurringDocument,
  RecurringPlanningUnavailable
> =>
  Effect.gen(function* () {
    const found = yield* findUserDocument({ db, userId, kind: "recurring-plan" });
    if (Option.isNone(found)) {
      return yield* Schema.decodeEffect(Schema.toType(RecurringDocument))(emptyRecurringDocument());
    }
    const row = found.value;
    const document = yield* Schema.decodeEffect(DocumentJson)(row.encoded);
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
}>): D1PreparedStatement =>
  prepareUserDocumentWrite({
    work,
    kind: "recurring-plan",
    encoded,
    revision: document.revision,
  });
export const encodeDocument = (
  document: RecurringDocument
): Effect.Effect<string, Schema.SchemaError> => Schema.encodeUnknownEffect(DocumentJson)(document);
