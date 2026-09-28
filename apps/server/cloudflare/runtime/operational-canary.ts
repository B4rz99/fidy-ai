import { type Cause, Effect, Exit, Option, Schema } from "effect";

const Canary = Schema.Struct({
  version: Schema.Literal(1),
  sentAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CanaryPayload = typeof Canary.Type;
const periodMs = 300_000;
const staleMs = 600_000;
const WorkflowStatus = Schema.Struct({
  status: Schema.Literals([
    "queued",
    "running",
    "waiting",
    "complete",
    "paused",
    "errored",
    "terminated",
    "unknown",
    "waitingForPause",
  ]),
});
const Check = Schema.Struct({
  kind: Schema.Literals(["queueExecution", "workflowExecution"]),
  last_succeeded_ms: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type CanaryHealth = Readonly<{
  component: "capability";
  operation: "queueExecution" | "workflowExecution";
}> &
  (
    | Readonly<{ state: "unavailable" }>
    | Readonly<{ state: "healthy" | "attention"; lastSucceededMs: number }>
  );

const recordCanary = (
  db: D1Database,
  kind: CanaryHealth["operation"],
  now: number
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db
      .prepare(`INSERT INTO operational_canary (kind, last_succeeded_ms) VALUES (?, ?)
    ON CONFLICT(kind) DO UPDATE SET last_succeeded_ms = MAX(last_succeeded_ms, excluded.last_succeeded_ms)`)
      .bind(kind, now)
      .run()
  ).pipe(Effect.asVoid);

/** An actual Queue consumer, not queue.send(), proves Queue execution. */
export const receiveCanary = (
  input: Readonly<{
    DB: D1Database;
    workflow: Readonly<{
      create: (input: { id: string; params: CanaryPayload }) => Promise<unknown>;
      get: (id: string) => Promise<{ status: () => Promise<unknown> }>;
    }>;
    payload: unknown;
    now: number;
  }>
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(Canary)(input.payload);
      if (
        Option.isNone(decoded) ||
        decoded.value.sentAtMs > input.now ||
        input.now - decoded.value.sentAtMs > staleMs
      ) {
        return yield* Effect.die(new Error("Invalid operational canary"));
      }
      yield* recordCanary(input.DB, "queueExecution", input.now);
      const id = `operational-canary-${Math.floor(decoded.value.sentAtMs / periodMs)}`;
      const created = yield* Effect.exit(
        Effect.tryPromise(() => input.workflow.create({ id, params: decoded.value }))
      );
      if (Exit.isFailure(created)) {
        // A redelivery may race a successful handoff; only a confirmed existing instance is safe.
        const instance = yield* Effect.tryPromise(() => input.workflow.get(id)).pipe(
          Effect.catch(() => Effect.failCause(created.cause))
        );
        const status = yield* Effect.tryPromise(() => instance.status()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(WorkflowStatus))
        );
        if (
          status.status === "errored" ||
          status.status === "terminated" ||
          status.status === "unknown"
        ) {
          return yield* Effect.failCause(created.cause);
        }
      }
    })
  );

/** Only a completed Workflow step proves Workflow execution. */
export const completeCanary = ({
  db,
  payload,
  now,
}: Readonly<{
  db: D1Database;
  payload: unknown;
  now: number;
}>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(Canary)(payload);
      if (
        Option.isNone(decoded) ||
        decoded.value.sentAtMs > now ||
        now - decoded.value.sentAtMs > staleMs
      ) {
        return yield* Effect.die(new Error("Invalid operational canary"));
      }
      yield* recordCanary(db, "workflowExecution", now);
    })
  );

/** Inspect private D1 evidence; absent/invalid state never becomes a healthy measurement. */
export const readCanaryHealth = ({
  db,
  now,
}: Readonly<{
  db: D1Database;
  now: number;
}>): Promise<ReadonlyArray<CanaryHealth>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const operations: ReadonlyArray<CanaryHealth["operation"]> = [
        "queueExecution",
        "workflowExecution",
      ];
      const rows = yield* Effect.exit(
        Effect.tryPromise(() =>
          db.prepare("SELECT kind, last_succeeded_ms FROM operational_canary").all()
        ).pipe(
          Effect.flatMap((response) =>
            Schema.decodeUnknownEffect(Schema.Array(Check))(response.results)
          )
        )
      );
      if (Exit.isFailure(rows)) {
        return operations.map((operation): CanaryHealth => ({
          component: "capability",
          operation,
          state: "unavailable",
        }));
      }
      return operations.map((operation): CanaryHealth => {
        const row = rows.value.find((item) => item.kind === operation);
        if (row === undefined) return { component: "capability", operation, state: "unavailable" };
        return {
          component: "capability",
          operation,
          state: now - row.last_succeeded_ms <= staleMs ? "healthy" : "attention",
          lastSucceededMs: row.last_succeeded_ms,
        };
      });
    })
  );

/** Sending is not success; missing Workflows and Queue delivery remain visible until a real completion. */
export const sendCanary = ({
  queue,
  now,
}: Readonly<{
  queue: Pick<Queue, "send">;
  now: number;
}>): Promise<void> => {
  const sentAtMs = Math.floor(now / periodMs) * periodMs;
  return Effect.runPromise(
    Effect.tryPromise(() => queue.send({ version: 1, sentAtMs } satisfies CanaryPayload)).pipe(
      Effect.asVoid
    )
  );
};
