import { oauthPaths } from "../src/shell/oauth-agents/contract";
import { handleOAuthRequest } from "./oauth-agents/runtime";
import { retainedWork } from "./core-http/retained-credential-owners.test-fixture";
import { browserSessionBindingResponse } from "./web-session/operations";
import type { ErasureRegistryNamespace } from "./erasure/contract";
import { makeBrowserLoginErasureStores } from "./browser-login/runtime";
import { makeWebSessionErasureStores } from "./web-session/runtime";
import type { ErasureStore } from "./erasure-store/contract";
import { registeredConnectionInstitutionIds } from "../src/shell/connections/contract";
import { Context, Effect, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { OutboundHttpLive } from "./outbound-http/runtime";
import type { TelemetryService } from "../src/shell/observability/contract";
import coreWorker, { makeCoreWorker } from "./core-worker";
import {
  ErasureRegistryTransport,
  UserTransactionCoordinator,
} from "./core-coordinator.test-fixture";
/** Direct owner integration retains Core's native reader policy under the test's owning Scope. */
export const fixtureNativeHttpClient = Effect.gen(function* () {
  const clients = yield* Layer.build(OutboundHttpLive).pipe(
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
  );
  return Context.get(clients, HttpClient.HttpClient);
});

export const fixtureWorker = coreWorker;
export const makeFixtureWorker = (telemetry: TelemetryService): typeof coreWorker =>
  makeCoreWorker({ telemetry, institutions: registeredConnectionInstitutionIds });

export { UserTransactionCoordinator } from "./core-coordinator.test-fixture";
export { makeCoreWorker } from "./core-worker";
export { runBillingCollectionWorkflow } from "./subscription/historical-collection.test-fixture";

export class DeployedRegistryFixture extends UserTransactionCoordinator {
  constructor(
    state: DurableObjectState,
    environment: ConstructorParameters<typeof UserTransactionCoordinator>[1] &
      Readonly<{ ROOT_COORDINATOR: ErasureRegistryNamespace }>
  ) {
    const bound = { ...environment, USER_TRANSACTION_COORDINATOR: environment.ROOT_COORDINATOR };
    delete bound.ERASURE_REGISTRY_COORDINATOR;
    super(
      {
        id: { name: undefined, equals: state.id.equals.bind(state.id) },
        storage: state.storage,
        waitUntil: state.waitUntil.bind(state),
      },
      bound
    );
  }
}
export class DeployedTransportFixture extends ErasureRegistryTransport {
  constructor(
    context: ConstructorParameters<typeof ErasureRegistryTransport>[0],
    environment: ConstructorParameters<typeof ErasureRegistryTransport>[1] &
      Readonly<{ ROOT_COORDINATOR: ErasureRegistryNamespace }>
  ) {
    const bound = { ...environment, USER_TRANSACTION_COORDINATOR: environment.ROOT_COORDINATOR };
    delete bound.ERASURE_REGISTRY_COORDINATOR;
    super(context, bound);
  }
}
/** Credential erasure composes both owners against the same native journey database. */
export const fixtureBrowserCredentialErasureStores = (
  db: D1Database
): ReadonlyArray<ErasureStore> => [
  ...makeWebSessionErasureStores(db),
  ...makeBrowserLoginErasureStores(db),
];

/** Isolated D1 owners still under test while peer domain and hosted adapters migrate.
 * Native credential journeys always enter the production ingress/Core and UserStore bindings. */
export const retainedCredentialOwner = ({
  request,
  environment,
}: {
  request: Request;
  environment: Parameters<typeof coreWorker.fetch>[1];
}): Promise<Response> => {
  const path = new URL(request.url).pathname;
  const work = Object.values(oauthPaths).some((owned) => owned === path)
    ? Option.some(
        handleOAuthRequest({
          request,
          db: environment.DB,
          browserOrigin: environment.BROWSER_ORIGIN,
          coordinator: environment.USER_TRANSACTION_COORDINATOR,
        })
      )
    : retainedWork({ request, environment, path });
  if (Option.isNone(work)) return coreWorker.fetch(request, environment);
  if (request.method === "GET" && path === oauthPaths.connections) {
    return Effect.runPromise(work.value);
  }
  return Effect.runPromise(
    browserSessionBindingResponse({ request, db: environment.DB }).pipe(
      Effect.flatMap(Option.match({ onNone: () => work.value, onSome: Effect.succeed }))
    )
  );
};
