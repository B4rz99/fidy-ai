import {
  ListCategoriesResponse,
  categoryResponseFromRows,
  categoryUnavailable,
  protectedCategoryRows,
  recordBrowserCategoryWork,
} from "@fidy/server/categories";
import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import {
  livePATAuthority,
  recordCategoryPATUse,
  recordLivePATUse,
} from "@fidy/server/tokens-runtime";
import { Option, Schema } from "effect";
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
      prepareOwnedStatement(db, recordLivePATUse(subject, current)),
      prepareOwnedStatement(db, protectedCategoryRows(livePATAuthority(subject, current))),
      prepareOwnedStatement(db, recordCategoryPATUse(subject, newId(), current)),
    ];
  }
  return [
    prepareOwnedStatement(db, protectedCategoryRows(liveWebSessionAuthority(subject, current))),
    prepareOwnedStatement(db, recordBrowserCategoryWork(subject, newId(), current)),
  ];
};

const refusedCategoryWork = async (
  db: D1Database,
  subject: TransactionSubject | AuthorizedPAT
): Promise<Response> => {
  if (
    "patId" in subject &&
    (await db
      .prepare("SELECT 1 FROM consent_user_revocations WHERE user_id = ?")
      .bind(subject.userId)
      .first()) !== null
  ) {
    return userActionRequired();
  }
  return unauthenticated();
};

const auditIndexFromEnd = -2;
const categoryWorkAccepted = (results: ReadonlyArray<D1Result>, pat: boolean): boolean =>
  results.at(auditIndexFromEnd)?.meta.changes === 1 && (!pat || results[0]?.meta.changes === 1);

const presentCategoryWork = async (
  db: D1Database,
  subject: TransactionSubject | AuthorizedPAT,
  results: ReadonlyArray<D1Result>
): Promise<Response> => {
  const pat = "patId" in subject;
  if (!categoryWorkAccepted(results, pat)) {
    return refusedCategoryWork(db, subject);
  }
  const rows = results[pat ? 1 : 0]?.results;
  const response = categoryResponseFromRows(rows);
  return Option.isSome(response)
    ? new Response(
        JSON.stringify(
          Schema.encodeSync(Schema.toCodecJson(ListCategoriesResponse))(response.value)
        ),
        { status: 200, headers }
      )
    : unavailable();
};

/** Query, live authority and shared User budget commit in one D1 unit for either credential. */
export const executeProtectedCategories = async (
  db: D1Database,
  subject: TransactionSubject | AuthorizedPAT
): Promise<Response> => {
  try {
    const results = await commitPATUnit(db, categoryStatements(db, subject, currentMillis()));
    return presentCategoryWork(db, subject, results);
  } catch {
    return unavailable();
  }
};
