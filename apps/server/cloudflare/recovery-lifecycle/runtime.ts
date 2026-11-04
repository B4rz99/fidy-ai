import type { AuthoritativeStoreEnvironment } from "../sqlite-store/contract";
import { select } from "./internal/selection";
import { environment as nativeEnvironment } from "./internal/environment";
import { database } from "./internal/database";
import { bucket } from "./internal/objects";
import type { RecoveryAdmissionEnvironment } from "../recovery-activation/contract";
import { Option, Schema } from "effect";
import { admitRecoveryContinuation, admitRecoveryOperation } from "./operations";
import type {
  RecoveryDispatchEnvironment,
  RecoveryLifecycleEnvironment,
  RecoveryNativeEnvironment,
  RecoveryNativeTracker,
  RecoveryOperationLease,
} from "./contract";
import { bindings as dispatchBindings } from "./internal/bindings";
import { publisher } from "./internal/dispatch";
import { native, within } from "./internal/context";
import { tracker as makeTracker } from "./internal/tracker";

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

type ResponseInput = Readonly<{
  response: Response;
  lease: RecoveryOperationLease;
  tracker: RecoveryNativeTracker;
  settle: () => Promise<void>;
}>;

const streamingResponse = ({ response, lease, tracker, settle }: ResponseInput): Response => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Streaming response has no body");
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller): Promise<void> =>
        lease
          .assertOpen()
          .then(() => within({ tracker, work: () => reader.read() }))
          .then((chunk) =>
            lease.assertOpen().then(() => {
              if (chunk.done) {
                return settle()
                  .then(() => tracker.settle())
                  .then(() => lease.complete())
                  .then(() => controller.close());
              }
              controller.enqueue(Schema.decodeUnknownSync(Schema.Uint8Array)(chunk.value));
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

const bufferedResponse = ({
  response,
  lease,
  tracker,
  settle,
}: ResponseInput): Promise<Response> => {
  const read =
    response.body === null
      ? Promise.resolve(null)
      : within({ tracker, work: () => response.arrayBuffer() });
  return read.then((body) =>
    settle()
      .then(() => tracker.settle())
      .then(() => lease.complete())
      .then(() => new Response(body, response))
  );
};

/** Financial release includes native continuation work, not only the handler's first Promise. */
const runFetch = ({
  environment,
  work,
  context,
  admit,
}: Readonly<{
  environment: RecoveryAdmissionEnvironment;
  work: (context: Option.Option<Lifetime>) => Promise<Response>;
  context: Option.Option<Lifetime>;
  admit: typeof admitRecoveryOperation;
}>): Promise<Response> => {
  if (
    environment.RECOVERY_ADMISSION === undefined &&
    environment.RECOVERY_SOURCE_EPOCH === undefined
  ) {
    return work(context);
  }
  return admit(environment)
    .then((admission) => {
      if (Option.isNone(admission)) return work(context);
      const lifetime = continuations(context);
      const tracker = makeTracker();
      return within({ tracker, work: () => work(lifetime.context) }).then((response) => {
        if (response.headers.get("content-type")?.split(";")[0] === "text/event-stream") {
          return admission.value.assertOpen().then(() =>
            streamingResponse({
              response,
              lease: admission.value,
              tracker,
              settle: lifetime.settle,
            })
          );
        }
        return bufferedResponse({
          response,
          lease: admission.value,
          tracker,
          settle: lifetime.settle,
        });
      });
    })
    .catch(unavailable);
};

type FetchInput = Readonly<{
  environment: RecoveryAdmissionEnvironment;
  work: (context: Option.Option<Lifetime>) => Promise<Response>;
  context: Option.Option<Lifetime>;
}>;

/** Ordinary HTTP ingress is refused after the source publisher pause. */
export const runRecoveryFetch = (input: FetchInput): Promise<Response> =>
  runFetch({ ...input, admit: admitRecoveryOperation });

/** Private native coordinator calls continue already-published work while paused. */
export const runRecoveryContinuationFetch = (input: FetchInput): Promise<Response> =>
  runFetch({ ...input, admit: admitRecoveryContinuation });

/** Exact operator routes retain their owner authentication and use source control IO. */
export const runRecoveryControl = <A>(work: () => Promise<A>): Promise<A> => {
  const tracker = makeTracker();
  return within({ tracker, work }).then((result) => tracker.settle().then(() => result));
};

/** Wrap selected capabilities before recovery guards or cancellable Effects capture them. */
export const withRecoveryNativeEnvironment = <Environment extends RecoveryNativeEnvironment>(
  environment: Environment
): Environment => nativeEnvironment(environment);

/** Native publishers retain their actual handoff Promise and stamp the trusted target epoch. */
export const withRecoveryDispatch = <Environment extends RecoveryDispatchEnvironment>(
  environment: Environment
): Environment => dispatchBindings(environment);

/** Narrow native publishers carry identities without gaining other Queue capabilities. */
export const makeRecoveryPublisher = <Work, Result>(
  input: Readonly<{
    binding: Readonly<{ send: (work: Work) => Promise<Result> }>;
    environment: RecoveryLifecycleEnvironment;
  }>
): Readonly<{ send: (work: Work) => Promise<Result> }> => publisher(input);

/** Native promises remain owned even when a surrounding Effect stops waiting for them. */
export const trackRecoveryNative = <A>(
  input: Readonly<{
    environment: RecoveryLifecycleEnvironment;
    work: () => Promise<A>;
  }>
): Promise<A> => native(input);

/** Wrap the selected native database below recovery guards and Effect cancellation. */
export const withRecoveryDatabase = (
  input: Readonly<{ binding: D1Database; environment: RecoveryLifecycleEnvironment }>
): D1Database => database(input);

/** Private object IO belongs to its root until the provider's actual Promise settles. */
export const withRecoveryBucket = <Bucket extends object>(
  input: Readonly<{ binding: Bucket; environment: RecoveryLifecycleEnvironment }>
): Bucket => bucket(input);

/** Resolve one target and retain actual source D1 or Store RPC promises before decoding. */
export const withRecoveryStore = <
  Environment extends AuthoritativeStoreEnvironment & RecoveryLifecycleEnvironment,
>(
  environment: Environment
): Omit<Environment, keyof AuthoritativeStoreEnvironment> & Readonly<{ DB: D1Database }> =>
  select(environment);
