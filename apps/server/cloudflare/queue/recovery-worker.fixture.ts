import { DurableObject } from "cloudflare:workers";
import { Clock, Effect, Schema } from "effect";
import { coreQueueHandler } from "./runtime";
import { makeWorkerTelemetry } from "../runtime/telemetry/operations";

const user = "10000000-0000-4000-8000-000000000001";

type Environment = Readonly<{ OWNER: DurableObjectNamespace<QueueRecorder>; WORK: Queue }>;

const availableStatus = 200,
  missingStatus = 404;

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

export class QueueRecorder extends DurableObject {
  offerable(now: number): (typeof Work.Type)[] {
    const sql = this.ctx.storage.sql;

    const rows = sql
      .exec(
        "UPDATE statement_submissions SET queued_at_ms=coalesce(queued_at_ms,?) WHERE status IN ('queued','processing') AND retention_expires_at_ms>? RETURNING 1 AS version,user_id AS userId,id AS submissionId",
        now,
        now
      )
      .toArray();

    return rows.map((row) => Schema.decodeUnknownSync(Work)(row));
  }
  record(id: string, attempt: number, dead: boolean): void {
    this.ctx.storage.sql.exec(
      dead ? "INSERT INTO dead_letters VALUES(?,?)" : "INSERT INTO deliveries VALUES(?,?)",
      id,
      attempt
    );
  }
  create(id: string, now: number): void {
    const sql = this.ctx.storage.sql;

    if (sql.exec("SELECT 1 FROM blocked WHERE id=?", id).toArray().length > 0) {
      throw Error("Synthetic provider outage");
    }

    sql.exec("INSERT INTO handoffs(id,completed_at_ms) VALUES(?,?)", id, now);
  }
  exists(id: string): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM handoffs WHERE id=?", id).toArray().length === 1
    );
  }
  override fetch(request: Request): Promise<Response> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const work = yield* Schema.decodeUnknownEffect(Work)(
          yield* Effect.tryPromise(() => request.json())
        );

        const now = yield* Clock.currentTimeMillis;

        const found = this.ctx.storage.sql
          .exec(
            "SELECT 1 FROM statement_submissions WHERE id=? AND user_id=? AND status IN('queued','processing') AND retention_expires_at_ms>?",
            work.submissionId,
            work.userId,
            now
          )
          .toArray();

        return new Response(null, { status: found.length === 1 ? availableStatus : missingStatus });
      })
    );
  }
}

const workflow = (owner: DurableObjectStub<QueueRecorder>): Workflow => ({
  create: (options) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const id = options?.id;

        if (id === undefined) throw Error("Missing identity");
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.tryPromise(() => owner.create(id, now));

        return instance(id);
      })
    ),
  get: (id) =>
    owner.exists(id).then((exists) => {
      if (!exists) throw Error("Workflow does not exist");

      return instance(id);
    }),
  createBatch: unavailable,
  deleteBatch: unavailable,
});

const consume = coreQueueHandler(makeWorkerTelemetry(() => undefined));

export default {
  fetch: (_req: Request, env: Environment): Promise<Response> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const work = yield* Effect.tryPromise(() => env.OWNER.getByName(user).offerable(now));
        const maximumOfferBatch = 100;

        for (let offset = 0; offset < work.length; offset += maximumOfferBatch) {
          yield* Effect.tryPromise(() =>
            env.WORK.sendBatch(
              work.slice(offset, offset + maximumOfferBatch).map((body) => ({ body }))
            )
          );
        }

        return new Response(null, { status: 202 });
      })
    ),
  queue: (batch: MessageBatch<unknown>, env: Environment): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dead = batch.queue === "recovery-dead",
          owner = env.OWNER.getByName(user);

        for (const message of batch.messages) {
          const work = yield* Schema.decodeUnknownEffect(Work)(message.body);
          yield* Effect.tryPromise(() => owner.record(work.submissionId, message.attempts, dead));
        }

        if (dead) {
          batch.ackAll();

          return;
        }

        yield* Effect.tryPromise(() =>
          consume(batch, {
            RELEASE_GIT_SHA: "synthetic-proof",
            USER_STORE: env.OWNER,
            STATEMENT_EXTRACTION_WORKFLOW: workflow(owner),
          })
        );
      })
    ),
};
