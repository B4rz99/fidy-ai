import { Effect, Option, Schema } from "effect";
import { prepareAuthorizedAuditCall, recordCanonicalPATWork } from "@fidy/server/audit";
import { RequestBodyPolicy, boundedJsonBody } from "../http/request-body";
import { makeDashboardCatalog } from "../../src/core/dashboard/catalog";
import { categoryIds } from "../../src/core/categories/operations";
import { DashboardCatalog, DashboardEdit } from "../../src/core/dashboard/model";
import { livePATAuthority, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  type TransactionCaller,
  callerAuthority,
  isPATCaller,
  liveTransactionAuthority,
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../transactions/transaction-boundary";
import { executeSingleCanonicalMutation } from "../mutations/canonical-mutation-unit";
import { dashboardCompletion, prepareDashboard, presentDashboard } from "./dashboard-mutation";

const editBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16_384,
  deadlineMilliseconds: 2_000,
});
type DashboardOperation =
  | "dashboard.getDashboard"
  | "dashboard.getDashboardView"
  | "dashboard.listDashboardCatalog"
  | "dashboard.applyDashboardEdit";

/** Catalog is a query; the three document-writing calls instead use the shared mutation unit. */
const catalog = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): Effect.Effect<Response> =>
  Effect.tryPromise(() => {
    const authority = callerAuthority({ subject, current });
    const audit = isPATCaller(subject)
      ? prepareOwnedStatement({
          db,
          statement: recordCanonicalPATWork({
            authority: livePATAuthority({ subject, current }),
            input: {
              id: transactionId(),
              current,
              operation: "dashboard.listDashboardCatalog",
              outcome: "accepted",
              afterOwnerWrite: false,
            },
          }),
        })
      : prepareAuthorizedAuditCall({
          db,
          authority,
          id: transactionId(),
          operation: "dashboard.listDashboardCatalog",
          outcome: "accepted",
          current,
          afterOwnerWrite: false,
        });
    return db.batch([
      ...(isPATCaller(subject)
        ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
        : []),
      audit,
      db.prepare(dashboardCompletion),
    ]);
  }).pipe(
    Effect.flatMap(() =>
      Schema.encodeEffect(Schema.toCodecJson(DashboardCatalog))(
        makeDashboardCatalog({ restaurantCategoryId: categoryIds.restaurantes })
      )
    ),
    Effect.map((data) => Response.json({ data, next: [] }, { headers: transactionNoStore })),
    Effect.orElseSucceed(transactionUnavailable)
  );

/** Execute Dashboard calls through live User authority without a nested document D1 batch. */
export const browseDashboard = ({
  db,
  subject,
  operation,
  request,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: DashboardOperation;
  request: Request;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = transactionNow();
    const live = yield* Effect.tryPromise(() =>
      liveTransactionAuthority({ db, subject, current })
    ).pipe(Effect.option);
    if (Option.isNone(live)) return transactionUnavailable();
    if (!live.value) {
      return transactionFailure({
        code: "unauthenticated",
        status: 401,
        message: "Present a valid credential and retry.",
      });
    }
    if (operation === "dashboard.listDashboardCatalog") {
      return yield* catalog({ db, subject, current });
    }
    if (operation !== "dashboard.applyDashboardEdit" && request.url.includes("?")) {
      return transactionFailure({
        code: "validation_failed",
        status: 400,
        message: "Invalid Dashboard edit.",
      });
    }
    const edit =
      operation === "dashboard.applyDashboardEdit"
        ? yield* Effect.tryPromise(() =>
            boundedJsonBody({
              request,
              policy: editBodyPolicy,
              schema: Schema.toCodecJson(DashboardEdit),
            })
          ).pipe(Effect.orElseSucceed(() => Option.none()))
        : Option.none<DashboardEdit>();
    const preparation = yield* prepareDashboard({
      work: { db, subject, current },
      operation,
      edit,
    });
    return yield* executeSingleCanonicalMutation({
      db,
      subject,
      current,
      preparation,
      present: (value) =>
        value._tag === "Owner" ? presentDashboard(value) : Effect.succeed(transactionUnavailable()),
      retryStatement: Option.none(),
      hostedFence: Option.none(),
    });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));
