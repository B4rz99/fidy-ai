import { Data, Effect, Option, Schema } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
  refusedByAuditBudget,
} from "../../../src/shell/audit/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { makeDashboardCatalog } from "../../../src/core/dashboard/operations";
import { categoryIds } from "../../../src/core/categories/contract";
import { DashboardCatalog, DashboardEdit } from "../../../src/core/dashboard/contract";
import {
  DashboardUnavailable,
  DashboardUninitialized,
} from "../../../src/shell/dashboard/contract";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { prepareOwnedStatement } from "../../database/operations";
import {
  type QueryCaller,
  callerAuthority,
  isPATCaller,
  liveTransactionAuthority,
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import {
  dashboardCompletion,
  findDashboardDocument,
  findDashboardValue,
  presentDashboard,
} from "./dashboard-mutation";
import type { DashboardQueryOperation, DashboardRequest } from "../contract";

const editBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16_384,
  deadlineMilliseconds: 2_000,
});

class DashboardQueryLimited extends Data.TaggedError("DashboardQueryLimited") {}

/** Query accounting rechecks authority; its only writes are credential and Audit metadata. */
const accountQuery = ({
  db,
  subject,
  current,
  operation,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  current: number;
  operation: DashboardQueryOperation;
}>): Effect.Effect<void, DashboardQueryLimited | DashboardUnavailable> =>
  Effect.tryPromise({
    try: () => {
      const authority = callerAuthority({ subject, current });
      const audit = isPATCaller(subject)
        ? prepareOwnedStatement({
            db,
            statement: recordCanonicalPATWork({
              authority: livePATAuthority({ subject, current }),
              input: {
                id: transactionId(),
                current,
                operation,
                outcome: "accepted",
                afterOwnerWrite: false,
              },
            }),
          })
        : prepareAuthorizedAuditCall({
            db,
            authority,
            id: transactionId(),
            operation,
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
    },
    catch: (cause) =>
      refusedByAuditBudget(cause) ? new DashboardQueryLimited() : new DashboardUnavailable(),
  }).pipe(Effect.asVoid);

/** Observe an existing document under the caller-held User coordination turn, never repairing it. */
export const queryDashboard = ({
  db,
  subject,
  operation,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  operation: DashboardQueryOperation;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = transactionNow();
    const live = yield* Effect.tryPromise(() => liveTransactionAuthority({ db, subject, current }));
    if (!live) {
      return transactionFailure({
        code: "unauthenticated",
        status: 401,
        message: "Present a valid credential and retry.",
      });
    }
    if (operation === "dashboard.listDashboardCatalog") {
      yield* accountQuery({ db, subject, current, operation });
      const data = yield* Schema.encodeEffect(Schema.toCodecJson(DashboardCatalog))(
        makeDashboardCatalog({ restaurantCategoryId: categoryIds.restaurantes })
      );
      return Response.json({ data, next: [] }, { headers: transactionNoStore });
    }
    const found = yield* findDashboardDocument({ db, userId: subject.userId });
    if (Option.isNone(found)) {
      yield* accountQuery({ db, subject, current, operation });
      const failure = DashboardUninitialized.make({
        error: {
          code: "dashboard_uninitialized",
          message: "Initialize your Dashboard explicitly, then read it again.",
        },
        next: [],
      });
      const body = yield* Schema.encodeEffect(Schema.toCodecJson(DashboardUninitialized))(failure);
      return Response.json(body, { status: 404, headers: transactionNoStore });
    }
    const value = yield* findDashboardValue({ db, userId: subject.userId, operation });
    if (Option.isNone(value) || value.value._tag !== "Owner") return transactionUnavailable();
    yield* accountQuery({ db, subject, current, operation });
    return yield* presentDashboard(value.value);
  }).pipe(
    Effect.catchTag("DashboardQueryLimited", () =>
      Effect.succeed(
        transactionFailure({
          code: "rate_limited",
          status: 429,
          message: "Daily audit budget exhausted.",
        })
      )
    ),
    Effect.orElseSucceed(transactionUnavailable)
  );

/** Decode individual mutation input; HTTP queries use the same owner as hosted queries. */
export const browseDashboard = (input: DashboardRequest): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { db, subject, request, operation } = input;
    if (operation !== "dashboard.applyDashboardEdit" && request.url.includes("?")) {
      return transactionFailure({
        code: "validation_failed",
        status: 400,
        message: "Invalid Dashboard input.",
      });
    }
    if (!("runMutation" in input)) {
      return yield* queryDashboard({ db, subject, operation: input.operation });
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
    return input.operation === "dashboard.applyDashboardEdit"
      ? yield* input.runMutation({
          operation: input.operation,
          input: Option.map(edit, (payload) => ({ payload })),
        })
      : yield* input.runMutation({ operation: input.operation, input: Option.some({}) });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));
