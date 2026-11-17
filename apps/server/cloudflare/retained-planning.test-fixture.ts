import { prepareBoundDashboardCatalog, prepareBoundDashboardView } from "./dashboard/operations";
import { Clock, Effect, Option, Schema } from "effect";
import type { CatalogOperation } from "../src/shell/canonical-catalog/contract";
import {
  protectCanonicalBrowserRequest,
  protectCanonicalBrowserSnapshot,
  protectCanonicalBrowserSource,
  protectCanonicalRequest,
} from "./canonical-admission/operations";
import type { CanonicalReadCompletion } from "./canonical-admission/contract";
import { executeCanonicalHttpQuery, executeCanonicalWork } from "./canonical-operations/operations";
import type { CanonicalWork } from "./canonical-operations/contract";
import type { TransactionCaller } from "./canonical-work/operations";
import { canonicalOperation } from "./routing/operations";
import { resolveCanonicalPATCredential } from "./tokens/operations";
import { prepareBoundBudgetWorkspace } from "./budgets/operations";

type RequestContext = Readonly<{
  request: Request;
  db: D1Database;
  operation: CatalogOperation;
  current: number;
}>;
const runOwner = Effect.fn(function* (
  context: RequestContext,
  subject: TransactionCaller,
  completion: Option.Option<CanonicalReadCompletion>
) {
  const { db, request, operation, current } = context;
  const execute = (work: CanonicalWork): Effect.Effect<Response> =>
    executeCanonicalWork({
      db,
      current,
      work,
      subject,
      completion,
      bucket: Option.none(),
      inference: Option.none(),
      oauthConfirmation: Option.none(),
      hostedFence: Option.none(),
    });
  if (operation.policy.kind === "query") {
    return yield* executeCanonicalHttpQuery({
      db,
      request,
      subject,
      operation: operation.id,
      browserOrigin: "https://app.fidyapp.com",
      completion,
      bucket: Option.none(),
      coordinate: execute,
    });
  }
  const input: Record<string, Schema.Json> = {};
  if (operation.httpFields.includes("params")) {
    input.params = { id: new URL(request.url).pathname.split("/").at(-1) ?? "" };
  }
  if (operation.httpFields.includes("payload")) {
    input.payload = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
      yield* Effect.tryPromise(() => request.clone().text())
    );
  }
  return yield* execute({ _tag: "Call", operation: operation.id, input });
});

const deniedStatus = 403;
const unauthenticatedStatus = 401;
const retainedPAT = Effect.fn(function* (context: RequestContext) {
  const subject = yield* resolveCanonicalPATCredential(context);
  if (typeof subject === "string") {
    return Response.json(
      {
        error: {
          code: subject === "user_action_required" ? "user_action_required" : "unauthenticated",
        },
        next: [],
      },
      { status: subject === "user_action_required" ? deniedStatus : unauthenticatedStatus }
    );
  }
  return yield* protectCanonicalRequest({
    ...context,
    caller: { _tag: "PAT", value: subject },
    work: runOwner(context, subject, Option.none()),
  });
});

/** Retained D1 peer, batch and alert tests exercise their actual admission and domain owners.
 * Public transport journeys for financial operations use the separate native User-store fixture. */
export const retainedPlanningWork = ({
  db,
  request,
}: Readonly<{ db: D1Database; request: Request }>): Option.Option<Promise<Response>> => {
  const selected = canonicalOperation({
    method: request.method,
    path: new URL(request.url).pathname,
  });
  if (Option.isNone(selected)) return Option.none();
  const operation = selected.value;
  if (
    !operation.id.startsWith("budgets.") &&
    !operation.id.startsWith("transactions.") &&
    !operation.id.startsWith("dashboard.")
  ) {
    return Option.none();
  }
  return Option.some(
    Effect.runPromise(
      Effect.gen(function* () {
        const context = { db, operation, request, current: yield* Clock.currentTimeMillis };
        if (request.headers.has("authorization")) return yield* retainedPAT(context);
        if (operation.id === "dashboard.getDashboardView" && new URL(request.url).search === "") {
          return yield* protectCanonicalBrowserSource({
            ...context,
            read: prepareBoundDashboardView,
          });
        }
        if (
          operation.id === "dashboard.listDashboardCatalog" &&
          new URL(request.url).search === ""
        ) {
          return yield* protectCanonicalBrowserSnapshot({
            ...context,
            operation: "dashboard.listDashboardCatalog",
            read: prepareBoundDashboardCatalog,
          });
        }
        if (operation.id === "budgets.getBudgetStatus") {
          return yield* protectCanonicalBrowserSnapshot({
            ...context,
            operation: "budgets.getBudgetStatus",
            read: prepareBoundBudgetWorkspace(request),
          });
        }
        return yield* protectCanonicalBrowserRequest({
          ...context,
          work: (subject, completion) => runOwner(context, subject, Option.some(completion)),
        });
      })
    )
  );
};
