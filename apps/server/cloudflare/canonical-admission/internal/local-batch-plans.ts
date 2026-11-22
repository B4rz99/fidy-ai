import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Data, Effect, Option, Schema } from "effect";
import {
  type CanonicalAdmissionFailure,
  type CanonicalOutcome,
  CanonicalRejection,
  type CanonicalRejectionOutcome,
  type LocalMutationPlan,
  type LocalMutationResult,
  canonicalRejectionStatus,
} from "../contract";
import { recurringDiscoveryIntervalMs } from "../../recurring/contract";
import { preserveStoreAlarm } from "../../runtime/sqlite/operations";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import type { UserId } from "../../../src/core/identity/contract";
import type { ErrorCode } from "../../../src/shell/public-http/contract";

export type Context = { user: UserId; current: number; storage: DurableObjectStorage } & Partial<{
  hostedTurn: string;
}>;

export type Prepare = (
  input: unknown,
  context: Context
) => Effect.Effect<LocalMutationPlan, CanonicalAdmissionFailure, SqliteClient>;

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
  outcome: CanonicalRejectionOutcome;
};

export class ChildRefused extends Data.TaggedError("ChildRefused")<Refusal> {}

export const childRejection = (failure: Refusal): CanonicalRejection =>
  new CanonicalRejection({
    status: canonicalRejectionStatus.badRequest,
    audit: { kind: "rejected", outcome: failure.outcome },
    code: failure.code,
    wireMessage: Option.some(failure.message),
    fields: Option.some([]),
    detail: Option.none(),
    next: [],
    batchChild: Option.some({ index: failure.index, operation: failure.operation.id }),
  });

const childFailure = (child: Child, rejection: CanonicalRejection): ChildRefused =>
  new ChildRefused({
    index: child.index,
    operation: child.operation,
    code: rejection.code,
    message: Option.getOrElse(rejection.wireMessage, () => ""),
    outcome: rejection.audit.kind === "accepted" ? "validation_failed" : rejection.audit.outcome,
  });

type Planned = { child: Child; plan: LocalMutationPlan };

export type Audit = (
  child: Pick<Child, "operation" | "index">,
  outcome: CanonicalOutcome
) => Effect.Effect<void, CanonicalAdmissionFailure, SqliteClient>;

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
      const plan = yield* child
        .prepare(child.input, context)
        .pipe(
          Effect.catchTag("CanonicalRejection", (rejection) =>
            Effect.fail(childFailure(child, rejection))
          )
        );

      if (
        plans.some(
          ({ plan: prior }) =>
            Option.isSome(prior.removedTarget) && plan.targets.includes(prior.removedTarget.value)
        )
      ) {
        return yield* new ChildRefused({
          index: child.index,
          operation: child.operation,
          code: "not_found",
          message: "The requested record is unavailable.",
          outcome: "not_found",
        });
      }

      if (!reserveTargets(plan, targets, premises)) {
        return yield* new ChildRefused({
          index: child.index,
          operation: child.operation,
          code: "validation_failed",
          message: "Two children address the same retained target.",
          outcome: "validation_failed",
        });
      }

      plans.push({ child, plan });
    }),
    { discard: true }
  );

  return plans;
});

export const refuseChild = Effect.fnUntraced(function* (failure: Refusal, audit: Audit) {
  yield* audit(failure, failure.outcome);

  return yield* childRejection(failure);
});

const commitChild = Effect.fnUntraced(function* (
  { child, plan }: Planned,
  context: Context,
  audit: Audit
) {
  const result = yield* plan.commit.pipe(
    Effect.catchTag("CanonicalRejection", (rejection) =>
      Effect.fail(childFailure(child, rejection))
    )
  );

  yield* Schema.decodeEffect(child.operation.success, { onExcessProperty: "error" })(result.body);
  yield* audit(child, "success");

  return {
    callId: child.callId,
    operation: child.operation.id,
    output: result.body,
  };
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
          (planned) => commitChild(planned, context, audit),
          { concurrency: 1 }
        );

        if (plans.some(({ child }) => child.operation.id.startsWith("transactions."))) {
          yield* preserveStoreAlarm(
            context.storage,
            context.current + recurringDiscoveryIntervalMs
          );
        }

        return {
          status: 200,
          outcome: "success" as const,
          body: { data: { results }, next: [] },
        } satisfies LocalMutationResult;
      })
    )
    .pipe(Effect.catchTag("ChildRefused", (failure) => refuseChild(failure, audit)));
});
