import { reviewPageSelection, reviewRelation } from "./review-page";
import { DateTime, Effect, Option, Schema } from "effect";
import { ReviewWorkspaceQuery, reviewPageSize } from "../../../src/core/ingestion/contract";
import {
  ReviewPageContext,
  maximumReviewExcerptCharacters,
} from "../../../src/shell/ingestion/contract";
import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import {
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import type { ReviewQueryWork } from "../contract";
import { ReviewUnavailable } from "../contract";
import { reviewAudit } from "./review-audit";
import { validationFailed } from "./statement-ingestion";

const maximumExcerptCells = 16;

const ContextRow = Schema.Struct({
  id: Schema.String,
  record_number: Schema.OptionFromNullOr(Schema.Int),
  expires_at_ms: Schema.Finite,
  received_at_ms: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  excerpt: Schema.OptionFromNullOr(Schema.String),
});

/** Browser-only source context shares the inbox's page order; originals never enter agent metadata. */
export const browseReviewPageContext = ({
  db,
  subject,
  request,
}: ReviewQueryWork): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const query = Schema.decodeOption(Schema.toCodecStringTree(ReviewWorkspaceQuery))(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    if (Option.isNone(query)) return validationFailed("Invalid review selection.");
    const current = transactionNow();
    const offset = Option.getOrElse(query.value.offset, () => 0);
    const { filter, params } = reviewPageSelection(query.value);
    const results = yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(contextSql(filter))
          .bind(
            current,
            subject.userId,
            ...params,
            query.value.limit ?? reviewPageSize,
            offset,
            current,
            current,
            maximumReviewExcerptCharacters,
            maximumExcerptCells,
            maximumReviewExcerptCharacters
          ),
        ...reviewAudit({
          work: { db, subject, current },
          operation: "ingestion.getReviewPageContext",
          accepted: true,
        }),
        prepareChangedRowAssertion({ db, scope: "ingestion_review" }),
      ])
    );
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ContextRow))(results[0]?.results);
    const data = yield* Schema.decodeEffect(Schema.toCodecJson(ReviewPageContext))({
      items: rows.map((row, index) => projectContext(row, offset + index + 1)),
    });
    const encoded = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(ReviewPageContext))(data);
    return Response.json({ data: encoded, next: [] }, { headers: transactionNoStore });
  }).pipe(
    Effect.mapError(() => new ReviewUnavailable()),
    Effect.orElseSucceed(transactionUnavailable)
  );

// Materialize the bounded page before inspecting any original, and clip inside D1 so raw
// statement rows (up to 2 MB each) never cross the database response boundary.
const contextSql = (filter: string): string => `WITH page AS MATERIALIZED (
        SELECT id,user_id,expires_at_ms FROM (
          ${reviewRelation}
        ) WHERE ${filter} ORDER BY expires_at_ms,id LIMIT ? OFFSET ?
      ) SELECT p.id,r.record_number,p.expires_at_ms,e.received_at_ms,
        CASE WHEN p.expires_at_ms > ? AND (r.source_kind='media' OR r.evidence_state='retained') THEN
          substr(CASE
            WHEN r.source_kind='media' AND m.expires_at_ms > ? THEN m.caption
            WHEN r.source_format='xlsx' AND json_valid(r.original_evidence) THEN (
              SELECT group_concat(cell_text,' · ') FROM (
                SELECT substr(coalesce(json_extract(c.value,'$.formattedText'),json_extract(c.value,'$.value')),1,?) AS cell_text
                FROM json_each(r.original_evidence,'$.cells') c LIMIT ?
              )
            )
            WHEN json_valid(r.original_evidence) THEN json_extract(r.original_evidence,'$.rawRecord')
            ELSE r.original_evidence END,1,?) ELSE NULL END AS excerpt
        FROM page p JOIN ingestion_review_items r ON r.user_id=p.user_id AND r.id=p.id
        LEFT JOIN media_submissions m ON m.user_id=r.user_id AND m.id=r.media_submission_id
        LEFT JOIN forwarded_email_receipts e ON e.user_id=r.user_id AND e.id=r.email_receipt_id
        ORDER BY p.expires_at_ms,p.id`;

const projectContext = (
  row: typeof ContextRow.Type,
  position: number
): (typeof ReviewPageContext.Encoded)["items"][number] => ({
  id: row.id,
  reference: Option.match(row.record_number, {
    onNone: () => `Elemento ${position}`,
    onSome: (number) => `Fila ${number}`,
  }),
  expiresAt: DateTime.formatIso(DateTime.makeUnsafe(row.expires_at_ms)),
  ...Option.match(row.received_at_ms, {
    onNone: () => ({}),
    onSome: (receivedAt) => ({ receivedAt: DateTime.formatIso(receivedAt) }),
  }),
  ...(row.expires_at_ms > transactionNow()
    ? Option.match(row.excerpt, {
        onNone: () => ({}),
        onSome: (text) => ({
          excerpt: text
            .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ")
            .replace(/\s+/gu, " ")
            .trim()
            .slice(0, maximumReviewExcerptCharacters),
        }),
      })
    : {}),
});
