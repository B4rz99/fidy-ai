import { Clock, Effect, Option, Schema } from "effect";
import type { CatalogOperation } from "../src/shell/canonical-catalog/contract";
import {
  protectCanonicalBrowserRequest,
  protectCanonicalBrowserSnapshot,
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
  if (!operation.id.startsWith("budgets.") && !operation.id.startsWith("transactions.")) {
    return Option.none();
  }
  return Option.some(
    Effect.runPromise(
      Effect.gen(function* () {
        const context = { db, operation, request, current: yield* Clock.currentTimeMillis };
        if (request.headers.has("authorization")) {
          const subject = yield* resolveCanonicalPATCredential(context);
          if (typeof subject === "string") throw new Error("Retained fixture requires a live PAT");
          return yield* protectCanonicalRequest({
            ...context,
            caller: { _tag: "PAT", value: subject },
            work: runOwner(context, subject, Option.none()),
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
