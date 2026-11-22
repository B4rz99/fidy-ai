import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import deliveryWorker from "./email-worker";
import { receiveForwardedEmail } from "./runtime";
import { StatementWork } from "./contract";
import type { ForwardedEmailMessage, NativeEmailEnvironment } from "./contract";

const rejectedStatus = 422,
  acceptedStatus = 204;

export class PrivateEmailFixture extends WorkerEntrypoint<NativeEmailEnvironment> {
  override fetch(request: Request): Promise<Response> {
    const env = this.env;

    return Effect.runPromise(
      Effect.gen(function* () {
        const bytes = new Uint8Array(yield* Effect.tryPromise(() => request.arrayBuffer()));
        const refusals: string[] = [];

        const raw = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes);
            controller.close();
          },
        });

        const message: ForwardedEmailMessage = {
          from: "sender@example.com",
          to: request.headers.get("fidy-fixture-to") ?? "",
          rawSize: bytes.byteLength,
          raw,
          setReject: (reason) => {
            refusals.push(reason);
          },
        };

        if (new URL(request.url).pathname === "/production") {
          yield* Effect.tryPromise(() => deliveryWorker.email(message, env));
        } else yield* receiveForwardedEmail({ message, environment: env });

        return new Response(null, {
          status: refusals.length > 0 ? rejectedStatus : acceptedStatus,
        });
      })
    );
  }
}

export default {
  queue(batch: MessageBatch<unknown>, env: { QUEUE_DIAGNOSTICS: R2Bucket }): Promise<void> {
    return Effect.runPromise(
      Effect.forEach(
        batch.messages,
        (message) =>
          Effect.gen(function* () {
            const work = yield* Schema.decodeUnknownEffect(StatementWork)(message.body);
            yield* Effect.tryPromise(() =>
              env.QUEUE_DIAGNOSTICS.put(work.submissionId, "dead-lettered")
            );
            message.ack();
          }),
        { discard: true }
      )
    );
  },
};
