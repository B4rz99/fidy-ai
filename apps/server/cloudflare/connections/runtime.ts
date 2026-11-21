import { cleanupGrant, expireAttempts, repairRetention } from "./internal/sqlite-retention";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { SecureRandom } from "effect/crypto";
import { activate } from "./internal/sqlite-activation";
import {
  executeSynchronization,
  offerSynchronizations,
  repairSynchronizationAlarm,
} from "./internal/synchronization";
import { browser } from "./internal/sqlite-browser";
import {
  bancolombiaSandboxActivation,
  bancolombiaSandboxAdmission,
  bancolombiaSandboxCleanup,
  bancolombiaSandboxPreparation,
} from "../bancolombia-authentication/runtime";
import type { BancolombiaSandboxEnvironment } from "../bancolombia-authentication/contract";
import { Effect, Layer, ManagedRuntime, Option, Redacted, Schema } from "effect";
import { readBoundWebSessionProof } from "../web-session/operations";
import {
  type ConnectionAdapters,
  ConnectionCallbackAdmission,
  ConnectionSandboxAdmission,
  SynchronizationWork,
  connectionCallbackPath,
} from "./contract";
import { continuationFailure } from "./internal/browser";

type NativeBrowserUnit = {
  request: Request;
  owns: (id: string) => boolean;
  storage: DurableObjectStorage;
  environment: BancolombiaSandboxEnvironment & { BROWSER_ORIGIN: string };
};

const unavailableStatus = 503;

const maximumCallbackLength = 8192;

const validCallbackKeys = (query: URLSearchParams): boolean =>
  Array.from(query.keys()).every(
    (key) =>
      ["code", "state", "error", "error_description", "iss"].includes(key) &&
      query.getAll(key).length === 1
  );

export const callbackResult = (
  request: Request
): Option.Option<Pick<ConnectionCallbackAdmission, "state" | "result">> => {
  const url = new URL(request.url);
  const query = url.searchParams;

  if (url.search.length > maximumCallbackLength || url.pathname !== connectionCallbackPath) {
    return Option.none();
  }

  if (!validCallbackKeys(query)) return Option.none();

  if (query.has("code") === query.has("error")) return Option.none();

  if (
    query.has("iss") &&
    query.get("iss") !== "https://auth1-api-open-finance-sandbox.ambientesbc.com"
  ) {
    return Option.none();
  }

  const [CallbackCode, CallbackDenied] = ConnectionCallbackAdmission.fields.result.members;

  return Option.all({
    state: Schema.decodeUnknownOption(ConnectionCallbackAdmission.fields.state)(query.get("state")),
    result: query.has("code")
      ? Option.map(
          Schema.decodeUnknownOption(CallbackCode.fields.code)(query.get("code")),
          (code) => CallbackCode.make({ code })
        )
      : Option.some(CallbackDenied.make({})),
  });
};

export const sandboxConnectionAdapters = ({
  environment,
  userId,
}: {
  environment: BancolombiaSandboxEnvironment;
  userId: string;
}): ConnectionAdapters => ({
  preparation: bancolombiaSandboxPreparation({ environment, userId }),
  activation: bancolombiaSandboxActivation({ environment, userId }),
  cleanup: bancolombiaSandboxCleanup(environment),
  grantKey: Option.map(
    Option.fromUndefinedOr(environment.BANCOLOMBIA_SANDBOX_GRANT_KEY),
    Redacted.make
  ),
  synchronization: Option.none(),
});

export const nativeConnectionBrowser = ({
  unit,
  adapters,
}: {
  unit: NativeBrowserUnit;
  adapters: ConnectionAdapters;
}): ReturnType<typeof browser> =>
  Effect.gen(function* () {
    if (new URL(unit.request.url).pathname !== connectionCallbackPath) {
      return yield* browser(unit, unit.environment.BROWSER_ORIGIN, adapters.preparation);
    }

    const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(unit.request));
    const result = callbackResult(unit.request);

    if (
      unit.request.method === "GET" &&
      Option.isSome(proof) &&
      Option.isSome(result) &&
      Option.isSome(adapters.activation) &&
      Option.isSome(adapters.grantKey)
    ) {
      yield* activate({
        unit,
        proof: proof.value,
        callback: result.value,
        bank: adapters.activation.value,
        key: adapters.grantKey.value,
        canSynchronize: Option.isSome(adapters.synchronization),
      });
    }

    return new Response(null, { status: 204 });
  }).pipe(
    Effect.provideService(
      ConnectionSandboxAdmission,
      bancolombiaSandboxAdmission(unit.environment)
    ),
    Effect.provideService(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => crypto.getRandomValues(new Uint8Array(size)))
    ),
    Effect.tapCause(() =>
      Effect.logWarning({
        component: "connections",
        operation: "connectionCallback",
        outcome: "unavailable",
      })
    ),
    Effect.catchCause(() => Effect.succeed(continuationFailure(unavailableStatus)))
  );

export const checkConnectionAlarm: typeof repairSynchronizationAlarm = (storage) =>
  repairSynchronizationAlarm(storage);

export const offerConnectionWork = (input: {
  now: number;
  storage: DurableObjectStorage;
  queue: Queue<SynchronizationWork>;
  owns: (user: string) => boolean;
  environment: BancolombiaSandboxEnvironment;
}): ReturnType<typeof offerSynchronizations> =>
  offerSynchronizations(input).pipe(
    Effect.provideService(
      ConnectionSandboxAdmission,
      bancolombiaSandboxAdmission(input.environment)
    )
  );

export const runConnectionWork = Effect.fn(
  function* (unit: NativeBrowserUnit, adapters: ConnectionAdapters) {
    const work = yield* Schema.decodeUnknownEffect(SynchronizationWork, {
      onExcessProperty: "error",
    })(yield* Effect.tryPromise(() => unit.request.json()));

    if (!unit.owns(work.userId)) return new Response(null, { status: 404 });

    if (Option.isNone(adapters.synchronization) || Option.isNone(adapters.grantKey)) {
      return new Response(null, { status: 503 });
    }

    yield* executeSynchronization({
      work,
      provider: adapters.synchronization.value,
      key: adapters.grantKey.value,
      storage: unit.storage,
    }).pipe(
      Effect.provideService(
        ConnectionSandboxAdmission,
        bancolombiaSandboxAdmission(unit.environment)
      )
    );

    return new Response(null, { status: 204 });
  },
  Effect.tapCause(() =>
    Effect.logWarning({
      component: "connections",
      operation: "runConnectionWork",
      outcome: "unavailable",
    })
  ),
  Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
);

const synchronizationRuntime = ManagedRuntime.make(Layer.empty);

export class ConnectionSynchronizationWorkflow extends WorkflowEntrypoint<
  { USER_STORE: DurableObjectNamespace },
  SynchronizationWork
> {
  run(event: WorkflowEvent<SynchronizationWork>, step: WorkflowStep): Promise<void> {
    return step.do(
      "commit-connection-page",
      { retries: { limit: 6, delay: "5 seconds", backoff: "exponential" } },
      () =>
        synchronizationRuntime.runPromise(
          Effect.gen({ self: this }, function* () {
            const work = yield* Schema.decodeEffect(SynchronizationWork, {
              onExcessProperty: "error",
            })(event.payload);

            if (event.instanceId !== work.jobId) {
              return yield* Effect.fail("invalid_synchronization" as const);
            }

            const body = yield* Schema.encodeEffect(Schema.fromJsonString(SynchronizationWork))(
              work
            );

            const result = yield* Effect.tryPromise(() =>
              this.env.USER_STORE.getByName(work.userId).fetch(
                "https://user.invalid/work/connection-synchronization",
                { method: "POST", body }
              )
            );

            if (!result.ok) return yield* Effect.fail("synchronization_unavailable" as const);
          })
        )
    );
  }
}

type RetentionUnit = { storage: DurableObjectStorage; adapters: ConnectionAdapters };

const cleanupEnabled = (adapters: ConnectionAdapters): boolean =>
  Option.isSome(adapters.grantKey) && Option.isSome(adapters.cleanup);

export const repairConnectionRetention = ({
  storage,
  adapters,
}: RetentionUnit): ReturnType<typeof repairRetention> =>
  repairRetention(storage, cleanupEnabled(adapters));

export const expireConnectionAttempts = ({
  storage,
  now,
  adapters,
}: RetentionUnit & { now: number }): ReturnType<typeof expireAttempts> =>
  expireAttempts(storage, now, cleanupEnabled(adapters));

export const cleanConnectionGrants = ({
  storage,
  adapters,
  owns,
}: RetentionUnit & { owns: (id: string) => boolean }): ReturnType<typeof cleanupGrant> =>
  Option.isSome(adapters.grantKey) && Option.isSome(adapters.cleanup)
    ? cleanupGrant({ storage, key: adapters.grantKey.value, bank: adapters.cleanup.value, owns })
    : Effect.succeed({ attempted: 0, failed: 0 });
