import { type OAuthCaller } from "../../../src/shell/oauth-agents/contract";
import { liveOAuthAuthority } from "../../../src/shell/oauth-agents/operations";
import {
  categoryUnavailable,
  decodeCategoryRead,
  prepareCategoryRead,
} from "../../../src/shell/categories/operations";
import { recordBrowserCategoryWork } from "./canonical-work";
import { readConsentStatus } from "../../consent/operations";
import { ListCategoriesResponse } from "../../../src/shell/categories/contract";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import { recordCanonicalPATWork, recordOAuthCall } from "../../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { Clock, Effect, Option, Schema } from "effect";
import { newId } from "../../secret-material/operations";
import { commitPATUnit } from "../../tokens/operations";
import { type TransactionCaller, isPATCaller } from "../../canonical-work/operations";

type CategoryCaller = TransactionCaller | OAuthCaller;
const oauthCaller = (subject: CategoryCaller): subject is OAuthCaller =>
  "oauthConnectionId" in subject;
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
  subject: CategoryCaller,
  current: number
): Array<D1PreparedStatement> => {
  if (oauthCaller(subject)) {
    const authority = liveOAuthAuthority({ subject, current });
    const auditStatement = recordOAuthCall({
      authority,
      id: newId(),
      current,
      operation: "categories.listCategories",
      outcome: "accepted",
    });
    return [
      prepareCategoryRead({ db, authority: Option.some(authority) }),
      db.prepare(auditStatement.sql).bind(...auditStatement.params),
    ];
  }
  if (isPATCaller(subject)) {
    const patUseStatement = recordLivePATUse({ subject, current });
    const auditStatement = recordCanonicalPATWork({
      authority: livePATAuthority({ subject, current }),
      input: {
        id: newId(),
        current,
        operation: "categories.listCategories",
        outcome: "accepted",
        afterOwnerWrite: false,
      },
    });
    return [
      db.prepare(patUseStatement.sql).bind(...patUseStatement.params),
      prepareCategoryRead({ db, authority: Option.some(livePATAuthority({ subject, current })) }),
      db.prepare(auditStatement.sql).bind(...auditStatement.params),
    ];
  }
  const auditStatement = recordBrowserCategoryWork({ subject, id: newId(), current });
  return [
    prepareCategoryRead({
      db,
      authority: Option.some(liveWebSessionAuthority({ subject, current })),
    }),
    db.prepare(auditStatement.sql).bind(...auditStatement.params),
  ];
};

const refusedCategoryWork = (
  db: D1Database,
  subject: CategoryCaller
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    if (oauthCaller(subject) || isPATCaller(subject)) {
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
  subject: CategoryCaller,
  results: ReadonlyArray<D1Result>
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const pat = !oauthCaller(subject) && isPATCaller(subject);
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
}: Readonly<{ db: D1Database; subject: CategoryCaller }>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const results = yield* Effect.tryPromise({
      try: () => commitPATUnit({ db, statements: categoryStatements(db, subject, current) }),
      catch: () => undefined,
    });
    return yield* presentCategoryWork(db, subject, results);
  }).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        if (!oauthCaller(subject)) return unavailable();
        const current = yield* Clock.currentTimeMillis;
        const authority = liveOAuthAuthority({ subject, current });
        const row = yield* Effect.tryPromise(() =>
          db
            .prepare(`SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}`)
            .bind(...authority.bindings)
            .first()
        );
        return row === null ? yield* refusedCategoryWork(db, subject) : unavailable();
      }).pipe(Effect.orElseSucceed(unavailable))
    )
  );
