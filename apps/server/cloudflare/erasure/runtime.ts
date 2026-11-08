import { executeProtectedRequest } from "./internal/protected-receiver";
import { ProtectedStorageHealth } from "./internal/protected-contract";
import { HttpClient } from "effect/http";
import { makeAccessSigningKeysOutboundHttp } from "../../src/shell/outbound-http/operations";
import type { ErasureOperatorEnvironment } from "./contract";
import { operatorRequest } from "./internal/operator-request";
import type { AuthenticatedWebSession } from "../web-session/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { ErasureRequest } from "../../src/core/erasure/contract";
import { authenticateWebSession } from "../web-session/operations";
import { boundedJsonBody, collectBoundedRequestBody } from "../http/operations";
import { RequestBodyPolicy } from "../http/contract";
import { captureTraceHeaders } from "../runtime/telemetry/operations";
import { ErasureBrowserAdmission } from "./contract";
import { guardedDatabase } from "./internal/database";
import { makeProtectedExecution } from "./internal/protected-execution";
import { type RecoveryMeasurement, makeRecoveryMeasurement } from "./internal/measurement";

type RecoveryEnvironment = Readonly<{ DB: D1Database }> &
  Partial<
    Readonly<{
      ERASURE_REQUIRED: string;
      ERASURE_BUCKET: R2Bucket;
      PROTECTED_STORAGE: Pick<Fetcher, "fetch">;
    }>
  >;

/** Native entrypoints supply the required private registry binding in the deployed topology. Missing required configuration fails closed when a data unit executes. */
const wrapRecovery = <Environment extends RecoveryEnvironment>(
  environment: Environment,
  measurement: Option.Option<RecoveryMeasurement>
): Environment =>
  environment.ERASURE_REQUIRED === "true" || environment.ERASURE_BUCKET !== undefined
    ? {
        ...environment,
        DB: guardedDatabase({
          db: environment.DB,
          bucket: Option.fromUndefinedOr(environment.ERASURE_BUCKET),
          measurement,
          execution: Option.map(Option.fromUndefinedOr(environment.PROTECTED_STORAGE), (binding) =>
            makeProtectedExecution({ binding, measurement })
          ),
        }),
      }
    : environment;

export const withErasureRecovery = <Environment extends RecoveryEnvironment>(
  environment: Environment
): Environment => wrapRecovery(environment, Option.none());

/** Measure the foreground request's existing recovery units without retaining their data or changing their execution. */
export const measureErasureRecovery = <Environment extends RecoveryEnvironment>(
  environment: Environment
): Readonly<{ environment: Environment; respond: (response: Response) => Response }> => {
  const measurement = makeRecoveryMeasurement();
  return {
    environment: wrapRecovery(environment, Option.some(measurement)),
    respond: measurement.respond,
  };
};

const admissionLifetimeMs = 5000;
const forbiddenStatus = 403;
const methodStatus = 405;
const invalidStatus = 400;
const unauthenticatedStatus = 401;
const unavailableStatus = 503;
const reply = (status: number): Response =>
  Response.json(
    { error: "erasure-unavailable" },
    { status, headers: { "cache-control": "no-store" } }
  );

const receive = (
  input: Readonly<{
    subject: AuthenticatedWebSession;
    request: Request;
    coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const admission = yield* Schema.decodeEffect(ErasureBrowserAdmission)({
      userId: input.subject.userId,
      sessionId: input.subject.id,
      digest: Array.from(input.subject.digest),
      deadlineMs: (yield* Clock.currentTimeMillis) + admissionLifetimeMs,
    });
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureBrowserAdmission))(
      admission
    );
    const headers = yield* captureTraceHeaders;
    return yield* Effect.tryPromise(() =>
      input.coordinator.getByName(input.subject.userId).fetch(
        new Request("https://coordinator.internal/erasure-admit", {
          method: "POST",
          headers,
          body,
          signal: input.request.signal,
        })
      )
    );
  }).pipe(Effect.orElseSucceed(() => reply(unavailableStatus)));

export const handleErasureRequest = (
  input: Readonly<{
    db: D1Database;
    request: Request;
    browserOrigin: string;
    coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (input.request.headers.get("origin") !== input.browserOrigin) return reply(forbiddenStatus);
    if (input.request.method !== "POST") return reply(methodStatus);
    if (new URL(input.request.url).searchParams.size !== 0) return reply(invalidStatus);
    const policy = yield* Schema.decodeEffect(RequestBodyPolicy)({
      maximumBytes: 1024,
      deadlineMilliseconds: 2000,
    });
    const body = yield* boundedJsonBody({
      request: input.request,
      policy,
      schema: Schema.Unknown,
    });
    const decoded = Option.flatMap(
      body,
      Schema.decodeUnknownOption(ErasureRequest, { onExcessProperty: "error" })
    );
    if (Option.isNone(decoded)) return reply(invalidStatus);
    const current = yield* Clock.currentTimeMillis;
    const subject = yield* Effect.tryPromise(() =>
      authenticateWebSession({ ...input, current, freshness: "fresh" })
    );
    if (Option.isNone(subject)) return reply(unauthenticatedStatus);
    return yield* receive({
      request: input.request,
      coordinator: input.coordinator,
      subject: subject.value,
    });
  }).pipe(Effect.orElseSucceed(() => reply(unavailableStatus)));

export const handleErasureOperator = (
  input: Readonly<{
    request: Request;
    environment: ErasureOperatorEnvironment;
  }>
): Effect.Effect<Response, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = makeAccessSigningKeysOutboundHttp({
      issuer: input.environment.CLOUDFLARE_ACCESS_ISSUER,
      httpClient: yield* HttpClient.HttpClient,
    });
    return yield* operatorRequest({ ...input, http });
  });

/** Only Core receives this private SQL execution capability; this entrypoint has no public route. */
export const receiveProtectedUnit = (
  input: Readonly<{
    request: Request;
    environment: Readonly<{ DB: D1Database; ERASURE_BUCKET: R2Bucket }>;
  }>
): Promise<Response> => {
  const url = new URL(input.request.url);
  if (input.request.method === "GET" && url.pathname === "/health" && url.search === "") {
    return Promise.resolve(
      Response.json(
        Schema.encodeSync(ProtectedStorageHealth)({ status: "available", protocol: 1 }),
        { headers: { "cache-control": "no-store" } }
      )
    );
  }
  if (
    input.request.method !== "POST" ||
    url.pathname !== "/execute" ||
    url.search !== "" ||
    input.request.headers.get("content-type") !== "application/json"
  ) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  return executeProtectedRequest(input);
};

const maximumHealthBytes = 1024;

/** Zero-SQL release readiness checks the same private execution capability used by protected units. */
export const protectedStorageAvailable = (
  binding: Pick<Fetcher, "fetch">
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      binding.fetch(new Request("https://protected-storage.internal/health"))
    );
    if (!response.ok) return false;
    const request = new Request("https://protected-storage.internal/execute", {
      method: "POST",
      body: response.body,
    });
    const bytes = yield* collectBoundedRequestBody(request, maximumHealthBytes);
    const text = yield* Effect.try(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    yield* Schema.decodeEffect(Schema.fromJsonString(ProtectedStorageHealth))(text);
    return true;
  }).pipe(Effect.orElseSucceed(() => false));
