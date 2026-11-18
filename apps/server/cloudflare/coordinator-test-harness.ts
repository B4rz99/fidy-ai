import type { UserStoreBindings } from "./directory/contract";
import {
  DeliveredObservation,
  WhatsAppStatusAdmission,
  claimDeliveryUrl,
  replyDeliveryUrl,
  reserveDeliveryUrl,
} from "./whatsapp/contract";
import { nativeD1Response } from "./d1-test-bridge.test-fixture";
import { Effect, Schema } from "effect";

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

const fixtureStatuses = new Map<string, number>(
  Object.entries({ [claimDeliveryUrl]: 201, [reserveDeliveryUrl]: 204, [replyDeliveryUrl]: 204 })
);
const missing = 404;
export const retainedAgentCallbackOwner: Pick<UserStoreBindings, "USER_STORE"> = {
  USER_STORE: {
    getByName: () => ({
      fetch: (url) =>
        Promise.resolve(
          new Response(null, { status: fixtureStatuses.get(new Request(url).url) ?? missing })
        ),
    }),
  },
};
/** The historical Agent fixture owns D1 Turns and proactive work. Native callback ownership is exercised by the workerd journeys. */
export class RetainedWhatsAppCoordinator extends UserCoordinator {
  private readonly database: D1Database;
  constructor(
    state: ConstructorParameters<typeof UserCoordinator>[0],
    environment: ConstructorParameters<typeof UserCoordinator>[1],
    configuration?: ConstructorParameters<typeof UserCoordinator>[2]
  ) {
    super(state, { ...environment, ...retainedAgentCallbackOwner }, configuration);
    this.database = environment.DB;
  }
  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/hosted-turn/whatsapp/status") {
      return super.fetch(request);
    }
    const send = (next: Request): Promise<Response> => super.fetch(next);
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const raw: unknown = yield* Effect.tryPromise(() => request.clone().json());
        if (Schema.is(DeliveredObservation)(raw)) {
          return yield* Effect.tryPromise(() => send(request));
        }
        const event = yield* Schema.decodeUnknownEffect(WhatsAppStatusAdmission)(raw);
        const row = yield* Effect.tryPromise(() =>
          this.database
            .prepare(
              `SELECT kind AS family,coalesce(turn_id,delivery_id,insight_event_id,id) AS operationId FROM whatsapp_deliveries WHERE user_id=? AND correlation_token=? AND business_phone_number_id=?`
            )
            .bind(event.userId, event.correlationToken, event.businessPhoneNumberId)
            .first()
        );
        if (row === null) return new Response(null, { status: 503 });
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          ...row,
          userId: event.userId,
          evidence: { ...event, _tag: "WhatsAppLifecycleEvent", portfolio: "portfolio" },
        });
        return yield* Effect.tryPromise(() =>
          send(new Request(request.url, { method: "POST", body }))
        );
      })
    );
  }
}
