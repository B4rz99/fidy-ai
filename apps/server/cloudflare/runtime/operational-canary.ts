import { Option, Schema } from "effect";

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

const recordCanary = async (
  db: D1Database,
  kind: CanaryHealth["operation"],
  now: number
): Promise<void> => {
  await db
    .prepare(`INSERT INTO operational_canary (kind, last_succeeded_ms) VALUES (?, ?)
    ON CONFLICT(kind) DO UPDATE SET last_succeeded_ms = MAX(last_succeeded_ms, excluded.last_succeeded_ms)`)
    .bind(kind, now)
    .run();
};

/** An actual Queue consumer, not queue.send(), proves Queue execution. */
export const receiveCanary = async (
  input: Readonly<{
    DB: D1Database;
    workflow: Readonly<{
      create: (input: { id: string; params: CanaryPayload }) => Promise<unknown>;
      get: (id: string) => Promise<{ status: () => Promise<unknown> }>;
    }>;
    payload: unknown;
    now: number;
  }>
): Promise<void> => {
  const decoded = Schema.decodeUnknownOption(Canary)(input.payload);
  if (
    Option.isNone(decoded) ||
    decoded.value.sentAtMs > input.now ||
    input.now - decoded.value.sentAtMs > staleMs
  ) {
    throw new Error("Invalid operational canary");
  }
  await recordCanary(input.DB, "queueExecution", input.now);
  const id = `operational-canary-${Math.floor(decoded.value.sentAtMs / periodMs)}`;
  try {
    await input.workflow.create({ id, params: decoded.value });
  } catch (original) {
    // A Queue redelivery may race a prior successful Workflow handoff. Only a confirmed
    // existing instance makes that retry safe to acknowledge; other failures still retry.
    const instance = await input.workflow.get(id).catch((): never => {
      throw original;
    });
    const status = Schema.decodeUnknownSync(WorkflowStatus)(await instance.status());
    if (["errored", "terminated", "unknown"].includes(status.status)) throw original;
  }
};

/** Only a completed Workflow step proves Workflow execution. */
export const completeCanary = async (
  db: D1Database,
  payload: unknown,
  now: number
): Promise<void> => {
  const decoded = Schema.decodeUnknownOption(Canary)(payload);
  if (
    Option.isNone(decoded) ||
    decoded.value.sentAtMs > now ||
    now - decoded.value.sentAtMs > staleMs
  ) {
    throw new Error("Invalid operational canary");
  }
  await recordCanary(db, "workflowExecution", now);
};

/** Inspect private D1 evidence; absent/invalid state never becomes a healthy measurement. */
export const readCanaryHealth = async (
  db: D1Database,
  now: number
): Promise<ReadonlyArray<CanaryHealth>> => {
  const operations: ReadonlyArray<CanaryHealth["operation"]> = [
    "queueExecution",
    "workflowExecution",
  ];
  try {
    const response = await db
      .prepare("SELECT kind, last_succeeded_ms FROM operational_canary")
      .all();
    const rows = Schema.decodeUnknownSync(Schema.Array(Check))(response.results);
    return operations.map((operation): CanaryHealth => {
      const row = rows.find((item) => item.kind === operation);
      if (row === undefined) return { component: "capability", operation, state: "unavailable" };
      return {
        component: "capability",
        operation,
        state: now - row.last_succeeded_ms <= staleMs ? "healthy" : "attention",
        lastSucceededMs: row.last_succeeded_ms,
      };
    });
  } catch {
    return operations.map((operation) => ({
      component: "capability",
      operation,
      state: "unavailable",
    }));
  }
};

/** Sending is not success; missing Workflows and Queue delivery remain visible until a real completion. */
export const sendCanary = async (queue: Pick<Queue, "send">, now: number): Promise<void> => {
  const sentAtMs = Math.floor(now / periodMs) * periodMs;
  await queue.send({ version: 1, sentAtMs } satisfies CanaryPayload);
};
