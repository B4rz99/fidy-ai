import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import type { CanonicalAuthorityRoot } from "../../../src/shell/canonical-policy/contract";
import { isHostedVisible } from "../../../src/shell/canonical-policy/operations";
import { grantsRequiredTier } from "../../../src/shell/canonical-operations/operations";
import { AtomicBatchAdmission } from "../../../src/shell/operations/contract";
import {
  CanonicalAdmissionUnavailable,
  type CanonicalOutcome,
  type LocalMutationPlan,
  validationRejection,
} from "../contract";
import { admissionFailure } from "./rejection";
import {
  type Audit,
  type Child,
  type Context,
  type Prepare,
  commitChildren,
  prepareChildren,
  refuseChild,
} from "./local-batch-plans";
import { selectChildren } from "./local-batch";
import { localStanding } from "./local-mutation";

type HostedContext = Context & {
  turnId: string;
  toolCallId: string;
  describe: (
    operation: string,
    input: Schema.Json
  ) => Effect.Effect<Option.Option<string>, never, SqliteClient>;
  authorityRoot: CanonicalAuthorityRoot;
};

const hostedAudit = (context: HostedContext): Audit =>
  Effect.fnUntraced(
    function* (child: Pick<Child, "index" | "operation">, outcome: CanonicalOutcome) {
      const sql = yield* SqliteClient;

      const saved =
        yield* sql`INSERT INTO hosted_batch_child_audit(turn_id,tool_call_id,position,operation,outcome,occurred_ms) VALUES(${context.turnId},${context.toolCallId},${child.index},${child.operation.id},${outcome},${context.current}) RETURNING position`;

      if (saved.length !== 1) {
        return yield* new CanonicalAdmissionUnavailable({ cause: "hosted_batch_audit" });
      }
    },
    Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
  );

const reviewPlans = Effect.fn(function* (
  plans: Effect.Success<ReturnType<typeof prepareChildren>>,
  describe: HostedContext["describe"]
) {
  const effects: string[] = [];
  const revisions: string[] = [];

  yield* Effect.forEach(
    plans,
    Effect.fnUntraced(function* ({ child, plan }) {
      const facts = Option.isSome(plan.review)
        ? Option.some(yield* plan.review.value)
        : Option.none();

      const description = Option.isSome(facts)
        ? Option.some(facts.value.effect)
        : yield* describe(child.operation.id, child.input);

      if (
        Option.isNone(description) ||
        (child.operation.policy.agentConfirmation === "required" && Option.isNone(facts))
      ) {
        return yield* new CanonicalAdmissionUnavailable({ cause: "unreviewed_hosted_child" });
      }

      effects.push(String(child.index + 1) + ". " + description.value);
      revisions.push(Option.isSome(facts) ? facts.value.revision : "");
    }),
    { discard: true }
  );

  return {
    effect: "Revisa estos cambios. Se aplicarán juntos.\n" + effects.join("\n"),
    revision: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
      revisions
    ),
  };
});

export const prepareHostedBatch = Effect.fn(function* (
  input: Schema.Json,
  context: HostedContext,
  owners: ReadonlyMap<string, Prepare>
) {
  const payload = Schema.decodeUnknownOption(AtomicBatchAdmission)(input);

  if (Option.isNone(payload)) {
    return yield* validationRejection("Invalid atomic batch input.");
  }

  const wire = Schema.decodeUnknownOption(Schema.Array(Schema.Json))(payload.value.payload.calls);

  if (Option.isNone(wire)) {
    return yield* validationRejection("Invalid atomic batch input.");
  }

  const selected = selectChildren({
    calls: wire.value,
    owners,
    allowed: (op) => isHostedVisible(op.policy.access, context.authorityRoot),
  });

  if ("invalid" in selected) {
    return yield* validationRejection("Invalid atomic batch input.");
  }

  const audit = hostedAudit(context);

  if ("refusal" in selected) return yield* refuseChild(selected.refusal, audit);

  const status = yield* localStanding(context.user, context.current);

  const unentitled = Option.fromUndefinedOr(
    selected.children.find(
      (child) =>
        !grantsRequiredTier({
          requiredTier: child.operation.policy.requiredTier,
          callerTier: status.accessTier,
        })
    )
  );

  if (Option.isSome(unentitled)) {
    return yield* refuseChild(
      {
        ...unentitled.value,
        code: "paywall_required",
        message: "Your Subscription tier does not grant this operation.",
        outcome: "validation_failed",
      },
      audit
    );
  }

  return yield* prepareChildren(selected.children, context).pipe(
    Effect.map((plans): LocalMutationPlan => ({
      targets: [],
      removedTarget: Option.none(),
      premises: [],
      transaction: "self",
      review: Option.some(
        reviewPlans(plans, context.describe).pipe(Effect.mapError(admissionFailure))
      ),
      commit: commitChildren(plans, context, audit).pipe(Effect.mapError(admissionFailure)),
    })),
    Effect.catchTag("ChildRefused", (failure) => refuseChild(failure, audit))
  );
}, Effect.mapError(admissionFailure));
