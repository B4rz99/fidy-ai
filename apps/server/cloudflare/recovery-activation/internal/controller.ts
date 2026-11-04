import { Schema } from "effect";
import {
  captureRecoveryNativeObserver,
  runRecoveryControlOperation,
} from "../../recovery-lifecycle/operations";
import { newId } from "../../secret-material/operations";
import { type RecoveryActivationEnvironment, RecoveryControllerClaim } from "../contract";

const unavailable = (): never => {
  throw Error("Recovery controller unavailable");
};
const retryReply = (operation: () => Promise<boolean>): Promise<boolean> =>
  operation().catch(operation);
const settleBody = (response: Response): Promise<Response> =>
  response.arrayBuffer().then((bytes) => new Response(bytes, response));

const observedBody = (
  body: ReadableStream,
  observe: ReturnType<typeof captureRecoveryNativeObserver>
): ReadableStream =>
  new Proxy(body, {
    get: (stream, member): unknown => {
      const value: unknown = Reflect.get(stream, member, stream);
      if (typeof value !== "function") return value;
      if (member === "cancel") {
        return (...args: Array<unknown>): Promise<unknown> =>
          observe(() => Promise.resolve(Reflect.apply(value, stream, args)));
      }
      return value.bind(stream);
    },
  });

/** Captured once before Effect scheduling; native R2 bodies remain owned by this exact controller. */
const observedBucket = (
  bucket: R2Bucket,
  observe: ReturnType<typeof captureRecoveryNativeObserver>
): R2Bucket =>
  new Proxy(bucket, {
    get: (binding, property): unknown => {
      const value: unknown = Reflect.get(binding, property, binding);
      if (typeof value !== "function") return value;
      return (...args: Array<unknown>): Promise<unknown> =>
        observe(() => Promise.resolve(Reflect.apply(value, binding, args))).then(
          (result: unknown) => {
            if (property !== "get" || typeof result !== "object" || result === null) return result;
            return new Proxy(result, {
              get: (object, member): unknown => {
                const bodyMethod: unknown = Reflect.get(object, member, object);
                if (member === "body" && bodyMethod instanceof ReadableStream) {
                  return observedBody(bodyMethod, observe);
                }
                if (typeof bodyMethod !== "function") return bodyMethod;
                return (...bodyArgs: Array<unknown>): Promise<unknown> =>
                  observe(() => Promise.resolve(Reflect.apply(bodyMethod, object, bodyArgs)));
              },
            });
          }
        );
    },
  });

/** Only the authenticated owner enters here. Opaque IDs never cross the public request/response boundary. */
export const runController = ({
  configuration,
  bucket,
  activationId,
  work,
}: Readonly<{
  configuration: RecoveryActivationEnvironment;
  bucket: R2Bucket;
  activationId: string;
  work: (
    owned: Readonly<{ configuration: RecoveryActivationEnvironment; bucket: R2Bucket }>
  ) => Promise<Response>;
}>): Promise<Response> => {
  const gate = configuration.admission;
  const claim = Schema.decodeSync(RecoveryControllerClaim)({
    epoch: configuration.sourceTarget.epoch,
    activationId,
    claimId: newId(),
  });
  return retryReply(() => gate.acquireController(claim)).then((acquired) => {
    if (!acquired) return unavailable();
    return runRecoveryControlOperation({
      environment: {
        DB: configuration.sourceDb,
        RECOVERY_SOURCE_EPOCH: claim.epoch,
        RECOVERY_ADMISSION: { getByName: () => gate },
      },
      work: (native) => {
        const observe = captureRecoveryNativeObserver();
        return work({
          configuration: { ...configuration, sourceDb: native.DB },
          bucket: observedBucket(bucket, observe),
        }).then(settleBody);
      },
    }).then(
      (response) =>
        retryReply(() => gate.releaseController(claim)).then((released) =>
          released ? response : unavailable()
        ),
      (failure: unknown) =>
        retryReply(() => gate.retainController(claim)).then(() => Promise.reject(failure))
    );
  });
};
