import { Clock, Effect, Schema } from "effect";
import { makeCoreQueue } from "./runtime";
import { makeWorkerTelemetry } from "../runtime/telemetry/operations";

type Environment = Readonly<{ DB: D1Database; WORK: Queue }>;
const Work = Schema.Struct({
  version: Schema.Literal(1),
  userId: Schema.String,
  submissionId: Schema.String,
});
const unavailable = (): Promise<never> =>
  Promise.reject(new Error("Synthetic unavailable Workflow"));
const instance = (id: string): WorkflowInstance => ({
  id,
  pause: unavailable,
  resume: unavailable,
  terminate: unavailable,
  restart: unavailable,
  delete: unavailable,
  sendEvent: unavailable,
  subscribe: unavailable,
  status: () => Promise.resolve({ status: "running" }),
});
const workflow = (db: D1Database): Workflow => ({
  create: (options) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const id = options?.id;
        if (id === undefined) throw new Error("Missing identity");
        const blocked = yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM blocked WHERE id = ?").bind(id).first()
        );
        if (blocked !== null) throw new Error("Synthetic provider outage");
        const current = yield* Clock.currentTimeMillis;
        yield* Effect.tryPromise(() =>
          db
            .prepare("INSERT INTO handoffs(id,completed_at_ms) VALUES (?,?)")
            .bind(id, current)
            .run()
        );
        return instance(id);
      })
    ),
  get: (id) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const existing = yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM handoffs WHERE id = ?").bind(id).first()
        );
        if (existing === null) throw new Error("Workflow does not exist");
        return instance(id);
      })
    ),
  createBatch: unavailable,
  deleteBatch: unavailable,
});
const consume = makeCoreQueue(makeWorkerTelemetry(() => undefined));
export default {
  fetch: (_request: Request, environment: Environment): Promise<Response> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* Effect.tryPromise(() =>
          environment.DB.prepare(
            "SELECT 1 AS version, user_id AS userId, id AS submissionId FROM statement_submissions WHERE status IN ('queued', 'processing') AND retention_expires_at_ms > ?"
          )
            .bind(now)
            .all()
        );
        const work = yield* Schema.decodeUnknownEffect(Schema.Array(Work))(rows.results);
        yield* Effect.tryPromise(() =>
          environment.DB.prepare(
            "UPDATE statement_submissions SET queued_at_ms=coalesce(queued_at_ms,?) WHERE status IN ('queued','processing')"
          )
            .bind(now)
            .run()
        );
        const maximumOfferBatch = 100;
        for (let offset = 0; offset < work.length; offset += maximumOfferBatch) {
          yield* Effect.tryPromise(() =>
            environment.WORK.sendBatch(
              work.slice(offset, offset + maximumOfferBatch).map((body) => ({ body }))
            )
          );
        }
        return new Response(null, { status: 202 });
      })
    ),
  queue: (batch: MessageBatch<unknown>, environment: Environment): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (batch.queue === "recovery-dead") {
          for (const message of batch.messages) {
            const work = yield* Schema.decodeUnknownEffect(Work)(message.body);
            yield* Effect.tryPromise(() =>
              environment.DB.prepare("INSERT INTO dead_letters VALUES (?, ?)")
                .bind(work.submissionId, message.attempts)
                .run()
            );
            message.ack();
          }
          return;
        }
        yield* Effect.tryPromise(() =>
          environment.DB.batch(
            batch.messages.map((message) => {
              const work = Schema.decodeUnknownSync(Work)(message.body);
              return environment.DB.prepare("INSERT INTO deliveries VALUES (?, ?)").bind(
                work.submissionId,
                message.attempts
              );
            })
          )
        );
        yield* Effect.tryPromise(() =>
          consume(batch, {
            DB: environment.DB,
            RELEASE_GIT_SHA: "synthetic-proof",
            USER_TRANSACTION_COORDINATOR: { getByName: () => ({ fetch: unavailable }) },
            STATEMENT_EXTRACTION_WORKFLOW: workflow(environment.DB),
          })
        );
      })
    ),
};
