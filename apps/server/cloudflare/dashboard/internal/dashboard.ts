import { Effect, Option, Schema } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { makeDashboardCatalog } from "../../../src/core/dashboard/operations";
import { categoryIds } from "../../../src/core/categories/contract";
import { DashboardCatalog, DashboardEdit } from "../../../src/core/dashboard/contract";
import { InitializeDashboardCanonicalInput } from "../../../src/shell/dashboard/contract";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { prepareOwnedStatement } from "../../database/operations";
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
} from "../../canonical-work/operations";
import { dashboardCompletion } from "./dashboard-mutation";
import type { DashboardMutationOperation, DashboardRequest } from "../contract";

const editBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16_384,
  deadlineMilliseconds: 2_000,
});
/** Catalog is a query; document-writing calls instead use the shared mutation unit. */
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

/** Validate live caller input and delegate document work to the same User's coordinated unit. */
export const browseDashboard = (input: DashboardRequest): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { db, subject } = input;
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
    if (input.operation === "dashboard.listDashboardCatalog") {
      return yield* catalog({ db, subject, current });
    }
    return yield* documentMutation(input);
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const documentMutation = (
  input: Extract<DashboardRequest, { operation: DashboardMutationOperation }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { request } = input;
    if (input.operation !== "dashboard.applyDashboardEdit" && request.url.includes("?")) {
      return transactionFailure({
        code: "validation_failed",
        status: 400,
        message: "Invalid Dashboard edit.",
      });
    }
    if (input.operation === "dashboard.initializeDashboard") {
      const initialization =
        request.body === null
          ? Option.some({})
          : yield* Effect.tryPromise(() =>
              boundedJsonBody({
                request,
                policy: editBodyPolicy,
                schema: InitializeDashboardCanonicalInput,
              })
            ).pipe(Effect.orElseSucceed(() => Option.none()));
      return yield* input.runMutation({ operation: input.operation, input: initialization });
    }
    const edit =
      input.operation === "dashboard.applyDashboardEdit"
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
  });
