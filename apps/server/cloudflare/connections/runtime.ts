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
  bancolombiaSandboxAdmission,
  makeBancolombiaSandboxActivation,
  makeBancolombiaSandboxCleanup,
  makeBancolombiaSandboxPreparation,
} from "../bancolombia-authentication/runtime";
import type { BancolombiaSandboxEnvironment } from "../bancolombia-authentication/contract";

import { observeApplicationOperation } from "../runtime/application-observation/operations";
import { sweepAttempts } from "./internal/retention";
import { sweepGrants } from "./internal/cleanup";
import { digestBytes } from "../secret-material/operations";
import { captureTraceHeaders } from "../runtime/telemetry/operations";
import { protectCanonicalPressure } from "../canonical-admission/operations";
import { Cause, Clock, Effect, Exit, Option, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import {
  type ConnectionBrowserApi,
  ConnectionContinuationInput,
} from "../../src/shell/connections/contract";
import { connectionBrowserTransport } from "../../src/shell/connections/runtime";
import {
  authenticateCanonicalWebSession,
  readBoundWebSessionProof,
} from "../web-session/operations";
import {
  type ConnectionAdapters,
  type ConnectionBankCleanup,
  ConnectionBrowserAdmission,
  ConnectionCallbackAdmission,
  ConnectionRetentionUnavailable,
  ConnectionSandboxAdmission,
  SynchronizationWork,
  connectionCallbackPath,
} from "./contract";
import { continuationFailure, reviewContinuation } from "./internal/browser";
import { RequestBodyPolicy } from "../http/contract";
import { boundedJsonBody } from "../http/operations";
import type { AuthenticatedWebSession } from "../web-session/contract";

type NativeBrowserUnit = {
  request: Request;
  owns: (id: string) => boolean;
  storage: DurableObjectStorage;
  environment: BancolombiaSandboxEnvironment & { BROWSER_ORIGIN: string };
};
const resourceLimitedStatus = 429;
const forbiddenStatus = 403;
const notFoundStatus = 404;
const methodNotAllowedStatus = 405;
const invalidStatus = 400;
const unauthenticatedStatus = 401;
const unavailableStatus = 503;
const maximumBytes = 1024;
const readDeadlineMilliseconds = 2000;
const admissionLifetimeMilliseconds = 5000;

const callbackRedirect = (browserOrigin: string): Response =>
  new Response(null, {
    status: 303,
    headers: {
      location: `${browserOrigin}/connections/result`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
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
  return Schema.decodeUnknownOption(
    Schema.Struct({
      state: ConnectionCallbackAdmission.fields.state,
      result: ConnectionCallbackAdmission.fields.result,
    })
  )({
    state: query.get("state"),
    result: query.has("code") ? { _tag: "Code", code: query.get("code") } : { _tag: "Denied" },
  });
};
const forwardCallback = (
  input: BrowserRequest,
  subject: AuthenticatedWebSession
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const parsed = callbackResult(input.request);
    if (Option.isNone(parsed)) return;
    const state = parsed.value.state;
    const stateDigest = Base64Url.encode(yield* digestBytes(new TextEncoder().encode(state)));
    const reference = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`SELECT a.public_reference FROM connection_attempts a JOIN connection_authorizations b ON b.attempt_id=a.id JOIN connections c ON c.id=a.connection_id
    WHERE b.state_digest=? AND c.user_id=? AND a.prepared_session_id=? AND b.phase='prepared' LIMIT 1`)
        .bind(stateDigest, subject.userId, subject.id)
        .first<string>("public_reference")
    );
    const current = yield* Clock.currentTimeMillis;
    const admission = yield* Schema.decodeUnknownEffect(ConnectionCallbackAdmission)({
      ...parsed.value,
      attempt: reference,
      userId: subject.userId,
      sessionId: subject.id,
      digest: Array.from(subject.digest),
      deadlineMilliseconds: current + admissionLifetimeMilliseconds,
    });
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ConnectionCallbackAdmission))(
      admission
    );
    yield* Effect.tryPromise(() =>
      input.coordinator.getByName(subject.userId).fetch(
        new Request("https://coordinator.internal/connection-callback", {
          method: "POST",
          body,
          signal: input.request.signal,
        })
      )
    );
  }).pipe(Effect.orElseSucceed(() => undefined));

export const handleConnectionCallback = (input: BrowserRequest): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (input.request.method !== "GET") {
      return new Response(null, { status: methodNotAllowedStatus, headers: { allow: "GET" } });
    }
    const current = yield* Clock.currentTimeMillis;
    const session = yield* Effect.tryPromise(() =>
      authenticateCanonicalWebSession({ ...input, current })
    );
    if (Option.isSome(session)) {
      yield* forwardCallback(input, session.value);
    }
    return callbackRedirect(input.browserOrigin);
  }).pipe(Effect.orElseSucceed(() => callbackRedirect(input.browserOrigin)));

type BrowserRequest = Readonly<{
  request: Request;
  db: D1Database;
  browserOrigin: string;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}>;
const reviewInput = (request: Request): Option.Option<typeof ConnectionContinuationInput.Type> => {
  const query = new URL(request.url).searchParams;
  if (query.getAll("attempt").length !== 1 || query.size !== 1) return Option.none();
  return Schema.decodeUnknownOption(ConnectionContinuationInput)({ attempt: query.get("attempt") });
};
const forwardBegin = (
  input: BrowserRequest,
  subject: AuthenticatedWebSession
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (new URL(input.request.url).searchParams.size !== 0) {
      return continuationFailure(invalidStatus);
    }
    const policy = yield* Schema.decodeEffect(RequestBodyPolicy)({
      maximumBytes,
      deadlineMilliseconds: readDeadlineMilliseconds,
    });
    const candidate = yield* boundedJsonBody({
      request: input.request,
      policy,
      schema: Schema.Unknown,
    });
    const parsed = Option.flatMap(
      candidate,
      Schema.decodeUnknownOption(ConnectionContinuationInput, { onExcessProperty: "error" })
    );
    if (Option.isNone(parsed)) return continuationFailure(invalidStatus);
    const current = yield* Clock.currentTimeMillis;
    const admission = yield* Schema.decodeEffect(ConnectionBrowserAdmission)({
      attempt: parsed.value.attempt,
      userId: subject.userId,
      sessionId: subject.id,
      digest: Array.from(subject.digest),
      deadlineMilliseconds: current + admissionLifetimeMilliseconds,
    });
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ConnectionBrowserAdmission))(
      admission
    );
    const traceHeaders = yield* captureTraceHeaders;
    return yield* Effect.tryPromise(() =>
      input.coordinator.getByName(subject.userId).fetch(
        new Request("https://coordinator.internal/connection-begin", {
          method: "POST",
          headers: traceHeaders,
          body,
          signal: input.request.signal,
        })
      )
    );
  }).pipe(Effect.orElseSucceed(() => continuationFailure(unavailableStatus)));

const admittedBrowserRequest = (
  input: BrowserRequest,
  subject: AuthenticatedWebSession,
  operation: keyof typeof ConnectionBrowserApi.groups.connectionBrowser.endpoints
): Effect.Effect<Response> => {
  switch (operation) {
    case "begin":
      return forwardBegin(input, subject);
    case "review":
      return Effect.gen(function* () {
        const parsed = reviewInput(input.request);
        if (Option.isNone(parsed)) return continuationFailure(invalidStatus);
        return yield* reviewContinuation({
          db: input.db,
          subject,
          attempt: parsed.value.attempt,
          current: yield* Clock.currentTimeMillis,
        });
      });
  }
};

export const handleConnectionBrowserRequest = (input: BrowserRequest): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (input.request.headers.get("origin") !== input.browserOrigin) {
      return continuationFailure(forbiddenStatus);
    }
    const transport = connectionBrowserTransport(new URL(input.request.url).pathname);
    if (Option.isNone(transport)) return continuationFailure(notFoundStatus);
    if (input.request.method !== transport.value.method) {
      return continuationFailure(methodNotAllowedStatus);
    }
    const current = yield* Clock.currentTimeMillis;
    const session = yield* Effect.tryPromise(() =>
      authenticateCanonicalWebSession({ ...input, current })
    );
    if (Option.isNone(session)) return continuationFailure(unauthenticatedStatus);
    return yield* protectCanonicalPressure({
      db: input.db,
      userId: session.value.userId,
      work: admittedBrowserRequest(input, session.value, transport.value.operation),
      refused: (response) =>
        Effect.succeed(
          response.status === resourceLimitedStatus
            ? response
            : continuationFailure(response.status)
        ),
    });
  }).pipe(Effect.orElseSucceed(() => continuationFailure(unavailableStatus)));

const minuteMilliseconds = 60_000;
const retentionCadenceMinutes = 60;
const cleanupCadenceMinutes = 5;

const recoveryPhase = (
  operation: "connections.attemptRetention" | "connections.grantCleanup",
  work: Effect.Effect<void, ConnectionRetentionUnavailable>
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      work.pipe(
        observeApplicationOperation({
          component: "api",
          operation,
          trigger: "schedule",
          spanOperation: "fidy.operation",
          workKind: "canonical_operation",
          metadata: { _tag: "None" },
        })
      )
    );
    if (Exit.isSuccess(result)) return true;
    if (Cause.hasInterrupts(result.cause)) return yield* Effect.interrupt;
    return false;
  });

export const recoverConnections = (
  input: Readonly<{
    db: D1Database;
    key: Option.Option<Redacted.Redacted<string>>;
    bank: Option.Option<ConnectionBankCleanup>;
    scheduledAtEpochMs: number;
  }>
): Effect.Effect<void, ConnectionRetentionUnavailable> =>
  Effect.gen(function* () {
    const scheduledMinute = Math.floor(input.scheduledAtEpochMs / minuteMilliseconds);
    let retained = true;
    if (scheduledMinute % retentionCadenceMinutes === 0) {
      retained = yield* recoveryPhase(
        "connections.attemptRetention",
        sweepAttempts({ db: input.db, current: yield* Clock.currentTimeMillis })
      );
    }
    let cleaned = true;
    if (scheduledMinute % cleanupCadenceMinutes === 0) {
      cleaned = yield* recoveryPhase("connections.grantCleanup", sweepGrants(input));
    }
    if (!retained || !cleaned) return yield* new ConnectionRetentionUnavailable();
  });

export const sandboxConnectionAdapters = ({
  environment,
  userId,
}: {
  environment: BancolombiaSandboxEnvironment;
  userId: string;
}): ConnectionAdapters => ({
  preparation: makeBancolombiaSandboxPreparation({ environment, userId }),
  activation: makeBancolombiaSandboxActivation({ environment, userId }),
  cleanup: makeBancolombiaSandboxCleanup(environment),
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
  Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
);

export class ConnectionSynchronizationWorkflow extends WorkflowEntrypoint<
  { USER_STORE: DurableObjectNamespace },
  SynchronizationWork
> {
  run(event: WorkflowEvent<SynchronizationWork>, step: WorkflowStep): Promise<void> {
    return step.do(
      "commit-connection-page",
      { retries: { limit: 6, delay: "5 seconds", backoff: "exponential" } },
      () =>
        Effect.runPromise(
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
