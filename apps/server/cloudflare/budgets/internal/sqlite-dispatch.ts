import { Effect, Option, Schema } from "effect";
import { BudgetId, CreateBudgetInput, UpdateBudgetInput } from "../../../src/core/budgets/contract";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import {
  canonicalAdmissionUnavailable,
  runLocalMutation,
} from "../../canonical-admission/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { budgetParameters } from "./budget-queries";
import { deleteLocalBudget, missingBudget, saveLocalBudget } from "./sqlite-planning";
import { queryLocalBudget } from "./sqlite-workspace";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});

export const isLocalBudgetOperation = (id: string): boolean =>
  [
    "budgets.listBudgets",
    "budgets.getBudget",
    "budgets.getBudgetStatus",
    "budgets.createBudget",
    "budgets.updateBudget",
    "budgets.deleteBudget",
  ].includes(id);

type Unit = Readonly<{
  request: Request;
  storage: DurableObjectStorage;
  owns: (user: string) => boolean;
  operation: CatalogOperation;
}>;

const queryOperation = Schema.Literals([
  "budgets.getBudget",
  "budgets.listBudgets",
  "budgets.getBudgetStatus",
]);

const dispatch = Effect.fn(function* (unit: Unit) {
  const { request, operation } = unit;
  const url = new URL(request.url);
  const id = Schema.decodeOption(BudgetId)(url.pathname.split("/").at(-1) ?? "");
  const invalidTarget = Option.isNone(id) ? Option.some(missingBudget()) : Option.none();

  switch (operation.id) {
    case "budgets.createBudget":
      return yield* runLocalMutation({
        ...unit,
        input: boundedJsonBody({
          request,
          policy,
          schema: Schema.toCodecJson(CreateBudgetInput),
        }).pipe(Effect.map(Option.map((input) => ({ input, id: Option.none<BudgetId>() })))),
        work: saveLocalBudget,
      });
    case "budgets.updateBudget":
      return yield* runLocalMutation(
        {
          ...unit,
          input: boundedJsonBody({
            request,
            policy,
            schema: Schema.toCodecJson(UpdateBudgetInput),
          }).pipe(
            Effect.map(
              Option.flatMap((input) => Option.map(id, (id) => ({ id: Option.some(id), input })))
            )
          ),
          work: saveLocalBudget,
        },
        invalidTarget
      );
    case "budgets.deleteBudget":
      return yield* runLocalMutation(
        { ...unit, input: Effect.succeed(id), work: deleteLocalBudget },
        invalidTarget
      );
    default:
      return yield* runLocalMutation({
        ...unit,
        input: Effect.succeed(
          Option.flatMap(Schema.decodeUnknownOption(queryOperation)(operation.id), (operation) =>
            budgetParameters({ operation, url })
          )
        ),
        work: queryLocalBudget,
      });
  }
});

export const dispatchLocalBudget = (
  unit: Unit
): Effect.Effect<Response, never, Effect.Services<ReturnType<typeof runLocalMutation>>> =>
  dispatch(unit).pipe(
    Effect.tapCause(() =>
      Effect.logWarning({
        component: "budgets",
        operation: "dispatchLocalBudget",
        outcome: "unavailable",
      })
    ),
    Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
  );
