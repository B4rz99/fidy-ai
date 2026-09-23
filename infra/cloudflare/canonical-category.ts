import {
  ListCategoriesResponse,
  categoryResponseFromRows,
  categoryRowsQuery,
  categoryUnavailable,
  recordBrowserCategoryWork,
} from "@fidy/server/categories";
import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import {
  livePATAuthority,
  recordCanonicalPATWork,
  recordLivePATUse,
} from "@fidy/server/tokens-runtime";
import { Effect, Option, Schema } from "effect";
import type { AuthorizedPAT } from "./pat-authorization";
import { currentMillis, newId } from "./pat-shared";
import { commitPATUnit, prepareOwnedStatement } from "./pat-unit";
import type { TransactionSubject } from "./transaction-boundary";

const headers = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" };
const unavailable = (): Response => Response.json(categoryUnavailable(), { status: 503, headers });
const unauthenticated = (): Response =>
  Response.json(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    { status: 401, headers }
  );
const userActionRequired = (): Response =>
  Response.json(
    {
      error: {
        code: "user_action_required",
        message: "Return to Fidy to review your withdrawn Consent.",
      },
      next: [],
    },
    { status: 403, headers }
  );

const categoryStatements = (
  db: D1Database,
  subject: TransactionSubject | AuthorizedPAT,
  current: number
): Array<D1PreparedStatement> => {
  if ("patId" in subject) {
    return [
      prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
      prepareOwnedStatement({
        db,
        statement: categoryRowsQuery(livePATAuthority({ subject, current })),
      }),
      prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          subject,
          input: {
            id: newId(),
            current,
            operation: "categories.listCategories",
            outcome: "accepted",
            afterSourceAttestation: false,
          },
        }),
      }),
    ];
  }
  return [
    prepareOwnedStatement({
      db,
      statement: categoryRowsQuery(liveWebSessionAuthority(subject, current)),
    }),
    prepareOwnedStatement({
      db,
      statement: recordBrowserCategoryWork({ subject, id: newId(), current }),
    }),
  ];
};

const refusedCategoryWork = (
  db: D1Database,
  subject: TransactionSubject | AuthorizedPAT
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    if ("patId" in subject) {
      const withdrawn = yield* Effect.tryPromise({
        try: () =>
          db
            .prepare("SELECT 1 FROM consent_user_revocations WHERE user_id = ?")
            .bind(subject.userId)
            .first(),
        catch: () => undefined,
      });
      if (withdrawn !== null) return userActionRequired();
    }
    return unauthenticated();
  });

const auditIndexFromEnd = -2;
const categoryWorkAccepted = (results: ReadonlyArray<D1Result>, pat: boolean): boolean =>
  results.at(auditIndexFromEnd)?.meta.changes === 1 && (!pat || results[0]?.meta.changes === 1);

const presentCategoryWork = (
  db: D1Database,
  subject: TransactionSubject | AuthorizedPAT,
  results: ReadonlyArray<D1Result>
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const pat = "patId" in subject;
    if (!categoryWorkAccepted(results, pat)) {
      return yield* refusedCategoryWork(db, subject);
    }
    const rows = results[pat ? 1 : 0]?.results;
    const response = categoryResponseFromRows(rows);
    if (Option.isNone(response)) return unavailable();
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ListCategoriesResponse))(
      response.value
    );
    return new Response(body, { status: 200, headers });
  });

/** Query, live authority and shared User budget commit in one D1 unit for either credential. */
export const executeProtectedCategories = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: TransactionSubject | AuthorizedPAT }>): Promise<Response> =>
  Effect.gen(function* () {
    const results = yield* Effect.tryPromise({
      try: () =>
        commitPATUnit({ db, statements: categoryStatements(db, subject, currentMillis()) }),
      catch: () => undefined,
    });
    return yield* presentCategoryWork(db, subject, results);
  }).pipe(Effect.orElseSucceed(unavailable), Effect.runPromise);
