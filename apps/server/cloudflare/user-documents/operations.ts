import { type Cause, Data, Effect, Option, Schema } from "effect";
import {
  type QueryCaller,
  type TransactionCaller,
  callerAuthority,
} from "../canonical-work/operations";

type Kind = "dashboard" | "recurring-plan";
const Stored = Schema.Struct({ encoded: Schema.String, revision: Schema.Int });
const NativeRows = Schema.Array(
  Schema.Struct({ success: Schema.Literal(true), results: Schema.Array(Schema.Unknown) })
);
const CallerProof = Schema.Struct({ authorized: Schema.Literal(1) });
class InvalidDocumentSnapshot extends Data.TaggedError("InvalidDocumentSnapshot") {}
const completeNativeRows = ({
  rows,
  count,
}: Readonly<{ rows: ReadonlyArray<D1Result>; count: number }>): boolean =>
  Schema.is(NativeRows)(rows) && rows.length === count;
const sourceRows = (
  rows: ReadonlyArray<D1Result>
): Option.Option<
  Readonly<{ proof: ReadonlyArray<unknown>; documents: ReadonlyArray<unknown> }>
> => {
  const proof = rows[0]?.results;
  const documents = rows[1]?.results;
  return proof === undefined || documents === undefined || proof.length > 1 || documents.length > 1
    ? Option.none()
    : Option.some({ proof, documents });
};

/**
 * Observe exact live authority, its gated document and at most two owner-prepared peer reads.
 * Peers must gate private rows with the same authority. This batch performs no writes and grants
 * no reusable authority. A failed observation is unavailable; it is never retried or classified
 * from an earlier proof. The enclosing operation retains its fresh Audit and disclosure checks.
 */
export const readAuthorizedUserDocumentSnapshot = (
  input: Readonly<{
    db: D1Database;
    subject: QueryCaller;
    current: number;
    kind: Kind;
    related: ReadonlyArray<D1PreparedStatement>;
  }>
): Effect.Effect<
  Readonly<{
    live: boolean;
    document: Option.Option<typeof Stored.Type>;
    related: ReadonlyArray<D1Result>;
  }>,
  Cause.UnknownError | Schema.SchemaError | InvalidDocumentSnapshot
> =>
  Effect.gen(function* () {
    if (input.related.length > 2) return yield* new InvalidDocumentSnapshot();
    const authority = callerAuthority(input);
    const results = yield* Effect.tryPromise(() =>
      input.db.batch([
        input.db
          .prepare(`SELECT 1 AS authorized FROM ${authority.table} WHERE ${authority.predicate}`)
          .bind(...authority.bindings),
        input.db
          .prepare(`SELECT document_json AS encoded,revision FROM user_documents
            WHERE user_id=? AND kind=? AND EXISTS
              (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
          .bind(input.subject.userId, input.kind, ...authority.bindings),
        ...input.related,
      ])
    );
    if (!completeNativeRows({ rows: results, count: input.related.length + 2 })) {
      return yield* new InvalidDocumentSnapshot();
    }
    const selected = sourceRows(results);
    if (Option.isNone(selected)) return yield* new InvalidDocumentSnapshot();
    const { proof, documents } = selected.value;
    if (proof.length === 0) return { live: false, document: Option.none(), related: [] };
    yield* Schema.decodeUnknownEffect(CallerProof)(proof[0]);
    const document =
      documents[0] === undefined
        ? Option.none()
        : Option.some(yield* Schema.decodeUnknownEffect(Stored)(documents[0]));
    return { live: true, document, related: results.slice(2) };
  });

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
