import { HttpClient } from "effect/http";
import { makeAccessSigningKeysOutboundHttp } from "../../src/shell/outbound-http/operations";
import {
  ErasureBrowserAdmission,
  ErasureCandidateConfiguration,
  type ErasureCandidateEnvironment,
  type ErasureOperatorEnvironment,
} from "./contract";
import { operatorRequest } from "./internal/operator-request";
import type { AuthenticatedWebSession } from "../web-session/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { ErasureRequest } from "../../src/core/erasure/contract";
import { authenticateWebSession } from "../web-session/operations";
import { boundedJsonBody } from "../http/operations";
import { RequestBodyPolicy } from "../http/contract";
import { captureTraceHeaders } from "../runtime/telemetry/operations";
import { guardedDatabase } from "./internal/database";
import { type RecoveryMeasurement, makeRecoveryMeasurement } from "./internal/measurement";

type RecoveryEnvironment = Readonly<{ DB: D1Database }> &
  Partial<Readonly<{ ERASURE_REQUIRED: string; ERASURE_BUCKET: R2Bucket }>>;

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
    return yield* operatorRequest({ ...input, http, candidateTargetId: Option.none() });
  });

/** Only an isolated operator Worker may construct this environment. Its DB and coordinator bindings belong to the candidate; neither may target serving resources. Verification never activates a database. */
export const handleErasureCandidateOperator = (
  input: Readonly<{ request: Request; environment: ErasureCandidateEnvironment }>
): Effect.Effect<Response, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const configuration = Schema.decodeOption(ErasureCandidateConfiguration)(input.environment);
    if (Option.isNone(configuration)) return reply(unavailableStatus);
    const targetId = configuration.value.ERASURE_CANDIDATE_DATABASE_ID;
    if (targetId === configuration.value.ERASURE_SERVING_DATABASE_ID) {
      return reply(unavailableStatus);
    }
    const http = makeAccessSigningKeysOutboundHttp({
      issuer: input.environment.CLOUDFLARE_ACCESS_ISSUER,
      httpClient: yield* HttpClient.HttpClient,
    });
    return yield* operatorRequest({ ...input, http, candidateTargetId: Option.some(targetId) });
  });
