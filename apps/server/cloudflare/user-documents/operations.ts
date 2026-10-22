import { type Cause, Effect, Option, Schema } from "effect";
import { type TransactionCaller, callerAuthority } from "../canonical-work/operations";

type Kind = "dashboard" | "recurring-plan";
const Stored = Schema.Struct({ encoded: Schema.String, revision: Schema.Int });

/** Read a document and its owner-prepared related reads in one native snapshot. */
export const readUserDocumentSnapshot = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    kind: Kind;
    related: ReadonlyArray<D1PreparedStatement>;
  }>
): Effect.Effect<
  Readonly<{ document: Option.Option<typeof Stored.Type>; related: ReadonlyArray<D1Result> }>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const results = yield* Effect.tryPromise(() =>
      input.db.batch([
        input.db
          .prepare(
            "SELECT document_json AS encoded,revision FROM user_documents WHERE user_id=? AND kind=?"
          )
          .bind(input.userId, input.kind),
        ...input.related,
      ])
    );
    const raw = results[0]?.results[0];
    const document =
      raw === undefined
        ? Option.none()
        : Option.some(yield* Schema.decodeUnknownEffect(Stored)(raw));
    return { document, related: results.slice(1) };
  });

export const findUserDocument = (
  input: Readonly<{ db: D1Database; userId: string; kind: Kind }>
): Effect.Effect<
  Option.Option<Readonly<{ encoded: string; revision: number }>>,
  Cause.UnknownError | Schema.SchemaError
> =>
  readUserDocumentSnapshot({ ...input, related: [] }).pipe(
    Effect.map((snapshot) => snapshot.document)
  );

export const prepareUserDocumentWrite = (
  input: Readonly<{
    work: Readonly<{ db: D1Database; subject: TransactionCaller; current: number }>;
    kind: Kind;
    encoded: string;
    revision: number;
  }>
): D1PreparedStatement => {
  const { work } = input;
  const authority = callerAuthority(work);
  return input.revision === 1
    ? work.db
        .prepare(`INSERT INTO user_documents(user_id,kind,document_json,revision)
      SELECT ?,?,?,1 WHERE EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
      ON CONFLICT(user_id,kind) DO NOTHING`)
        .bind(work.subject.userId, input.kind, input.encoded, ...authority.bindings)
    : work.db
        .prepare(`UPDATE user_documents SET document_json=?,revision=?
      WHERE user_id=? AND kind=? AND revision=? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
        .bind(
          input.encoded,
          input.revision,
          work.subject.userId,
          input.kind,
          input.revision - 1,
          ...authority.bindings
        );
};
