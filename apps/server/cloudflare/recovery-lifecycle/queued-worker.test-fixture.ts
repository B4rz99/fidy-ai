import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import type { RecoveryAdmissionBinding } from "../recovery-activation/contract";
import { observeRecoveryDrain, runRecoveryOperation, runRecoveryQueue } from "./operations";
import { makeRecoveryPublisher, withRecoveryStore } from "./runtime";

export { RecoveryAdmissionGate } from "../recovery-activation/runtime";

export class ConsumerBarrier extends DurableObject {
  private readonly ready = Promise.withResolvers<void>();
  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/release") this.ready.resolve();
    return this.ready.promise.then(() => new Response(null, { status: 204 }));
  }
}

type Environment = Readonly<{
  DB: D1Database;
  WORK: Queue;
  BARRIER: { getByName(name: string): Pick<Fetcher, "fetch"> };
  RECOVERY_SOURCE_EPOCH: string;
  RECOVERY_ADMISSION: { getByName(name: string): RecoveryAdmissionBinding };
}>;
const barrier = (environment: Environment, path: string): Promise<Response> =>
  environment.BARRIER.getByName("consumer-start").fetch(
    new Request(`https://fixture.invalid/${path}`)
  );
const gate = (environment: Environment): RecoveryAdmissionBinding =>
  environment.RECOVERY_ADMISSION.getByName("source-admission-v1");

/** Synthetic owner settlement exercises native Queue scheduling; no real provider is contacted. */
export default {
  fetch(request: Request, environment: Environment): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/publish") {
      return runRecoveryOperation({
        environment,
        work: () =>
          makeRecoveryPublisher({ binding: environment.WORK, environment })
            .send({ id: "retained-intent" })
            .then(() => new Response(null, { status: 202 })),
      }).catch(() => new Response(null, { status: 503 }));
    }
    if (path === "/pause") {
      return gate(environment)
        .pause({ epoch: "source-epoch", activationId: "cutover" })
        .then(() => barrier(environment, "release"));
    }
    if (path === "/close") {
      return gate(environment)
        .close({ epoch: "source-epoch", activationId: "cutover" })
        .then((value) => Response.json(value));
    }
    if (path === "/leases") {
      return gate(environment)
        .inspect()
        .then((value) => Response.json(value));
    }
    return Effect.runPromise(observeRecoveryDrain({ db: environment.DB })).then((value) =>
      Response.json(value)
    );
  },
  queue(batch: MessageBatch<unknown>, environment: Environment): Promise<void> {
    return barrier(environment, "wait").then(() =>
      runRecoveryQueue({
        environment,
        batch,
        work: () => {
          const { DB } = withRecoveryStore(environment);
          return DB.prepare(
            "UPDATE pending_consent_exchanges SET state='outbound_started',disclosure_message_id='synthetic-provider-receipt' WHERE id='retained-intent' AND state='awaiting_delivery'"
          )
            .run()
            .then(() => {
              for (const message of batch.messages) message.ack();
            });
        },
      })
    );
  },
};
