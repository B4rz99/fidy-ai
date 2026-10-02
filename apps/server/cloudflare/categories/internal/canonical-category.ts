import { decodeCategoryRead, prepareCategoryRead } from "../../../src/shell/categories/operations";
import { recordBrowserCategoryWork } from "./canonical-work";
import { readConsentStatus } from "../../consent/operations";
import { ListCategoriesResponse, categoryUnavailable } from "@fidy/server/categories";
import { liveWebSessionAuthority } from "@fidy/server/identity-operations";
import { recordCanonicalPATWork } from "@fidy/server/audit";
import { livePATAuthority, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { Effect, Option, Schema } from "effect";
import { currentMillis, newId } from "../../pats/pat-shared";
import { commitPATUnit, prepareOwnedStatement } from "../../pats/pat-unit";
import { type TransactionCaller, isPATCaller } from "../../canonical-work/operations";

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
  subject: TransactionCaller,
  current: number
): Array<D1PreparedStatement> => {
  if (isPATCaller(subject)) {
    return [
      prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
      prepareCategoryRead({ db, authority: Option.some(livePATAuthority({ subject, current })) }),
      prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          authority: livePATAuthority({ subject, current }),
          input: {
            id: newId(),
            current,
            operation: "categories.listCategories",
            outcome: "accepted",
            afterOwnerWrite: false,
          },
        }),
      }),
    ];
  }
  return [
    prepareCategoryRead({
      db,
      authority: Option.some(liveWebSessionAuthority({ subject, current })),
    }),
    prepareOwnedStatement({
      db,
      statement: recordBrowserCategoryWork({ subject, id: newId(), current }),
    }),
  ];
};

const refusedCategoryWork = (
  db: D1Database,
  subject: TransactionCaller
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    if (isPATCaller(subject)) {
      const standing = yield* readConsentStatus({ db, userId: subject.userId }).pipe(
        Effect.mapError(() => undefined)
      );
      if (standing === "Revoked") return userActionRequired();
    }
    return unauthenticated();
  });

const auditIndexFromEnd = -2;
const categoryWorkAccepted = (results: ReadonlyArray<D1Result>, pat: boolean): boolean =>
  results.at(auditIndexFromEnd)?.meta.changes === 1 && (!pat || results[0]?.meta.changes === 1);

const presentCategoryWork = (
  db: D1Database,
  subject: TransactionCaller,
  results: ReadonlyArray<D1Result>
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const pat = isPATCaller(subject);
    if (!categoryWorkAccepted(results, pat)) {
      return yield* refusedCategoryWork(db, subject);
    }
    const rows = results[pat ? 1 : 0]?.results;
    const response = decodeCategoryRead(rows);
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
}: Readonly<{ db: D1Database; subject: TransactionCaller }>): Promise<Response> =>
  Effect.gen(function* () {
    const results = yield* Effect.tryPromise({
      try: () =>
        commitPATUnit({ db, statements: categoryStatements(db, subject, currentMillis()) }),
      catch: () => undefined,
    });
    return yield* presentCategoryWork(db, subject, results);
  }).pipe(Effect.orElseSucceed(unavailable), Effect.runPromise);
