import type { RecoveryAdmissionEnvironment } from "../recovery-activation/contract";
import { Option } from "effect";
import { admitRecoveryOperation } from "./operations";
import type { RecoveryOperationLease } from "./contract";

type Lifetime = Pick<ExecutionContext, "waitUntil">;

const unavailable = (): Response =>
  Response.json(
    {
      error: { code: "unavailable", message: "Service temporarily unavailable." },
      next: [],
    },
    { status: 503, headers: { "cache-control": "no-store" } }
  );

const continuations = (
  context: Option.Option<Lifetime>
): Readonly<{
  context: Option.Option<Lifetime>;
  settle: () => Promise<void>;
}> => {
  const pending: Array<Promise<unknown>> = [];
  const settle = (observed = 0): Promise<void> => {
    const next = pending.slice(observed);
    if (next.length === 0) return Promise.resolve();
    return Promise.all(next).then(() => settle(observed + next.length));
  };
  return {
    context: Option.map(context, (parent) => ({
      waitUntil: (work: Promise<unknown>): void => {
        pending.push(work);
        parent.waitUntil(work.catch(() => undefined));
      },
    })),
    settle,
  };
};

const streamingResponse = (
  response: Response,
  lease: RecoveryOperationLease,
  settle: () => Promise<void>
): Response => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Streaming response has no body");
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller): Promise<void> =>
        lease
          .assertOpen()
          .then(() => reader.read())
          .then((chunk) =>
            lease.assertOpen().then(() => {
              if (chunk.done) {
                return settle()
                  .then(() => lease.complete())
                  .then(() => controller.close());
              }
              controller.enqueue(chunk.value);
              return undefined;
            })
          )
          .catch((failure: unknown) => controller.error(failure)),
      // Cancellation proves only local loss of interest, not settlement of underlying work.
      cancel: (reason: unknown): Promise<void> => reader.cancel(reason),
    },
    { highWaterMark: 0 }
  );
  return new Response(body, response);
};

const bufferedResponse = (
  response: Response,
  lease: RecoveryOperationLease,
  settle: () => Promise<void>
): Promise<Response> => {
  const read = response.body === null ? Promise.resolve(null) : response.arrayBuffer();
  return read.then((body) =>
    settle()
      .then(() => lease.complete())
      .then(() => new Response(body, response))
  );
};

/** Financial release includes native continuation work, not only the handler's first Promise. */
export const runRecoveryFetch = ({
  environment,
  work,
  context,
}: Readonly<{
  environment: RecoveryAdmissionEnvironment;
  work: (context: Option.Option<Lifetime>) => Promise<Response>;
  context: Option.Option<Lifetime>;
}>): Promise<Response> =>
  admitRecoveryOperation(environment)
    .then((admission) => {
      if (Option.isNone(admission)) return work(context);
      const lifetime = continuations(context);
      return work(lifetime.context).then((response) => {
        if (response.headers.get("content-type")?.split(";")[0] === "text/event-stream") {
          return admission.value
            .assertOpen()
            .then(() => streamingResponse(response, admission.value, lifetime.settle));
        }
        return bufferedResponse(response, admission.value, lifetime.settle);
      });
    })
    .catch(unavailable);
