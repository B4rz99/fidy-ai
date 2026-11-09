import { Clock, Effect, Option, Schema } from "effect";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import {
  ErasureRegistryMigration,
  type ErasureRegistryOwnerConfiguration,
  type ErasureRegistryOwnerEnvironment,
  erasureRegistryName,
} from "../contract";
import { registryCutover } from "./registry-cutover";
import { registryRequest } from "./registry-transport";

const maximumAdmissionMs = 5000;
const completeStatus = 200;
const restoreStatus = 202;
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 2048,
  deadlineMilliseconds: 2000,
});
const unavailable = (): Response =>
  new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
const migrate = (
  request: Request,
  controller: ReturnType<typeof registryCutover>,
  release: string
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return unavailable();
    const admission = yield* boundedJsonBody({ request, policy, schema: ErasureRegistryMigration });
    if (Option.isNone(admission)) return unavailable();
    if (admission.value.expectedRelease !== release) return unavailable();
    const current = yield* Clock.currentTimeMillis;
    const { deadlineMs, authority } = admission.value;
    if (
      deadlineMs <= current ||
      deadlineMs > current + maximumAdmissionMs ||
      deadlineMs > authority.expiresAtMs
    ) {
      return unavailable();
    }
    const status = yield* controller.migrate;
    return Response.json(
      { status, release },
      {
        status: status === "Complete" ? completeStatus : restoreStatus,
        headers: { "cache-control": "no-store" },
      }
    );
  }).pipe(Effect.orElseSucceed(unavailable));

/** One independent metadata authority, with no queue held across calls to a User coordinator. */
export const registryOwner = <Bound extends ErasureRegistryOwnerEnvironment>(
  input: ErasureRegistryOwnerConfiguration<Bound>
): Pick<Fetcher, "fetch"> => {
  const bucket = input.environment.ERASURE_BUCKET;
  if (bucket === undefined || input.state.id.name !== erasureRegistryName) {
    return { fetch: () => Promise.resolve(unavailable()) };
  }
  const controller = registryCutover({
    storage: input.state.storage,
    db: input.environment.DB,
    bucket,
  });
  return {
    fetch: (target, init) => {
      const request = new Request(target, init);
      const url = new URL(request.url);
      if (url.origin === "https://erasure-registry.invalid") {
        return Effect.runPromise(
          url.pathname === "/migrate"
            ? migrate(request, controller, input.environment.RELEASE_GIT_SHA)
            : registryRequest({ request, registry: controller.registry })
        );
      }
      return input.read(request, { ...input.environment, ERASURE_REGISTRY: controller.registry });
    },
  };
};
