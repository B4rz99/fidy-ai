import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Data, Effect, Option, Schema } from "effect";
import type {
  CanonicalAdmissionUnavailable,
  LocalMutationPlan,
  LocalMutationPreparation,
  LocalMutationResult,
} from "../contract";
import { recurringDiscoveryIntervalMs } from "../../recurring/contract";
import { preserveStoreAlarm } from "../../runtime/sqlite/operations";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import type { UserId } from "../../../src/core/identity/contract";
import { ErrorCode } from "../../../src/shell/public-http/contract";

export type Context = { user: UserId; current: number; storage: DurableObjectStorage } & Partial<{
  hostedTurn: string;
}>;

export type Prepare = (
  input: unknown,
  context: Context
) => Effect.Effect<LocalMutationPreparation, CanonicalAdmissionUnavailable, SqliteClient>;

export type SelectedChild<Owner> = {
  callId: string;
  operation: CatalogOperation;
  input: Schema.Json;
  index: number;
  prepare: Owner;
};

export type Child = SelectedChild<Prepare>;

export type Refusal = {
  operation: CatalogOperation;
  index: number;
  code: ErrorCode;
  message: string;
};

export class ChildRefused extends Data.TaggedError("ChildRefused")<Refusal> {}

export const failed = ({ index, operation, code, message }: Refusal): LocalMutationResult => ({
  status: 400,
  outcome: "validation_failed",
  body: {
    error: { code, message, failedCallIndex: index, operation: operation.id, fields: [] },
    next: [],
  },
});

export const refusalOutcome = (failure: Refusal): LocalMutationResult["outcome"] => {
  if (failure.code === "not_found") return "not_found";

  if (failure.code === "quota_exhausted" && failure.operation.id.startsWith("memory.")) {
    return "resource_limit";
  }

  return "validation_failed";
};

const childFailure = (child: Child, outcome: LocalMutationResult): ChildRefused => {
  const decoded = Schema.decodeUnknownSync(
    Schema.Struct({ error: Schema.Struct({ code: ErrorCode, message: Schema.String }) })
  )(outcome.body);

  return new ChildRefused({ ...child, ...decoded.error });
};

const firstFailureStatus = 400;

type Planned = { child: Child; plan: LocalMutationPlan };

type Outcome = LocalMutationResult["outcome"];

export type Audit = (
  child: Pick<Child, "operation" | "index">,
  outcome: Outcome
) => Effect.Effect<void, CanonicalAdmissionUnavailable, SqliteClient>;

const reserveTargets = (
  plan: LocalMutationPlan,
  targets: Set<string>,
  premises: Set<string>
): boolean => {
  if (
    plan.targets.some((target) => targets.has(target) || premises.has(target)) ||
    plan.premises.some((premise) => targets.has(premise))
  ) {
    return false;
  }

  for (const target of plan.targets) targets.add(target);

  for (const premise of plan.premises) premises.add(premise);

  return true;
};

export const prepareChildren = Effect.fn(function* (
  children: ReadonlyArray<Child>,
  context: Context
) {
  const plans: Planned[] = [],
    targets = new Set<string>(),
    premises = new Set<string>();

  yield* Effect.forEach(
    children,
    Effect.fnUntraced(function* (child) {
      const plan = yield* child.prepare(child.input, context);

      if (!("commit" in plan)) return yield* childFailure(child, plan);

      if (
        plans.some(
          ({ plan: prior }) =>
            Option.isSome(prior.removedTarget) && plan.targets.includes(prior.removedTarget.value)
        )
      ) {
        return yield* new ChildRefused({
          ...child,
          code: "not_found",
          message: "The requested record is unavailable.",
        });
      }

      if (!reserveTargets(plan, targets, premises)) {
        return yield* new ChildRefused({
          ...child,
          code: "validation_failed",
          message: "Two children address the same retained target.",
        });
      }

      plans.push({ child, plan });
    }),
    { discard: true }
  );

  return plans;
});

export const refuseChild = Effect.fnUntraced(function* (failure: Refusal, audit: Audit) {
  return yield* audit(failure, refusalOutcome(failure)).pipe(Effect.as(failed(failure)));
});

export const commitChildren = Effect.fn(function* (
  plans: ReadonlyArray<Planned>,
  context: Context,
  audit: Audit
) {
  const sql = yield* SqliteClient;

  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const results = yield* Effect.forEach(
          plans,
          Effect.fnUntraced(function* ({ child, plan }) {
            const result = yield* plan.commit;

            if (result.status >= firstFailureStatus) return yield* childFailure(child, result);
            yield* Schema.decodeEffect(child.operation.success, { onExcessProperty: "error" })(
              result.body
            );
            yield* audit(child, result.outcome);

            return {
              callId: child.callId,
              operation: child.operation.id,
              output: result.body,
            };
          })
        );

        if (plans.some(({ child }) => child.operation.id.startsWith("transactions."))) {
          yield* preserveStoreAlarm(
            context.storage,
            context.current + recurringDiscoveryIntervalMs
          );
        }

        return { status: 200, outcome: "success" as const, body: { data: { results }, next: [] } };
      })
    )
    .pipe(Effect.catchTag("ChildRefused", (failure) => refuseChild(failure, audit)));
});
