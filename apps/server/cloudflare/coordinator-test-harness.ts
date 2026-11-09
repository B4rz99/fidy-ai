import { nativeD1Response } from "./d1-test-bridge.test-fixture";
import { Schema } from "effect";

import { UserTransactionCoordinator as UserCoordinator } from "./transactions/runtime";
import {
  handleErasureRegistry,
  makeRemoteErasureRegistry,
  makeSqliteErasureRegistry,
} from "./erasure/runtime";

export class ErasureRegistryFixture {
  private readonly registry;
  constructor(state: Pick<DurableObjectState, "storage">) {
    this.registry = makeSqliteErasureRegistry(state.storage);
  }
  fetch(request: Request): Promise<Response> {
    return handleErasureRegistry({ request, registry: this.registry });
  }
}
export class UserTransactionCoordinator {
  private readonly delegate: UserCoordinator;
  constructor(
    state: ConstructorParameters<typeof UserCoordinator>[0],
    environment: ConstructorParameters<typeof UserCoordinator>[1] &
      Partial<
        Readonly<{
          ERASURE_REGISTRY_COORDINATOR: Readonly<{
            getByName: (name: string) => Pick<Fetcher, "fetch">;
          }>;
        }>
      >,
    configuration?: ConstructorParameters<typeof UserCoordinator>[2]
  ) {
    const registry = environment.ERASURE_REGISTRY_COORDINATOR;
    this.delegate = new UserCoordinator(
      state,
      registry === undefined
        ? environment
        : {
            ...environment,
            ERASURE_REGISTRY: makeRemoteErasureRegistry(registry.getByName("fixture-registry")),
          },
      configuration
    );
  }
  fetch(request: Request): Promise<Response> {
    return this.delegate.fetch(request);
  }
  alarm(): Promise<void> {
    return this.delegate.alarm();
  }
}

const maximumAdvanceMilliseconds = 60_000;
const ClockAdvance = Schema.Struct({
  milliseconds: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximumAdvanceMilliseconds)
  ),
});
const nativeNow = Date.now.bind(Date);
let elapsedMilliseconds = 0;

export default {
  fetch: (
    request: Request,
    environment: Readonly<Record<string, D1Database>>
  ): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      if (path === "/DB/query" && environment.DB !== undefined) {
        return nativeD1Response({ database: environment.DB, request });
      }
      if (path === "/SNAPSHOT_DB/query" && environment.SNAPSHOT_DB !== undefined) {
        return nativeD1Response({ database: environment.SNAPSHOT_DB, request });
      }
    }
    if (new URL(request.url).pathname !== "/__fixture/clock" || request.method !== "POST") {
      return Promise.resolve(new Response("not_found", { status: 404 }));
    }
    return request.json().then((body: unknown) => {
      const advance = Schema.decodeUnknownSync(ClockAdvance)(body);
      elapsedMilliseconds += advance.milliseconds;
      Date.now = (): number => nativeNow() + elapsedMilliseconds;
      return new Response(null, { status: 204 });
    });
  },
};
