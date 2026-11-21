import { Effect, Exit, Option, Schema } from "effect";
import type { OperationalSignal, QueueKind } from "../contract";

type WorkflowStatusBinding = Readonly<{
  get: (id: string) => Promise<{ status: () => Promise<InstanceStatus> }>;
}>;

const Status = Schema.Struct({
  status: Schema.Literals([
    "queued",
    "running",
    "paused",
    "errored",
    "terminated",
    "complete",
    "waiting",
    "waitingForPause",
    "unknown",
  ]),
});

const Backlog = Schema.Struct({
  backlogCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  backlogBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const unavailableSignal = (
  operation: OperationalSignal["operation"]
): OperationalSignal => ({
  component: "async-health",
  operation,
  state: "unavailable",
});

export const inspectWorkflow = Effect.fnUntraced(function* (
  workflow: Option.Option<WorkflowStatusBinding>,
  id: string
) {
  if (Option.isNone(workflow)) return "unavailable";

  const status = yield* Effect.exit(
    Effect.tryPromise(() => workflow.value.get(id).then((instance) => instance.status())).pipe(
      Effect.timeout("2 seconds"),
      Effect.flatMap(Schema.decodeUnknownEffect(Status))
    )
  );

  if (Exit.isFailure(status) || status.value.status === "unknown") return "unavailable";

  return ["errored", "terminated", "paused"].includes(status.value.status) ? "failed" : "available";
});

export const inspectQueue = ({
  operation,
  queue,
}: Readonly<{
  operation: QueueKind | "deadLetters";
  queue: Option.Option<Pick<Queue, "metrics">>;
}>): Effect.Effect<OperationalSignal> =>
  Effect.gen(function* () {
    if (Option.isNone(queue)) return unavailableSignal(operation);

    const backlog = yield* Effect.exit(
      Effect.tryPromise(() => queue.value.metrics()).pipe(
        Effect.timeout("2 seconds"),
        Effect.flatMap(Schema.decodeUnknownEffect(Backlog))
      )
    );

    if (Exit.isFailure(backlog)) return unavailableSignal(operation);

    return {
      component: "async-health",
      operation,
      ...backlog.value,
      state: backlog.value.backlogCount > 0 ? "attention" : "healthy",
    };
  });
