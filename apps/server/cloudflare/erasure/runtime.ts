import { HttpClient } from "effect/http";
import { makeAccessSigningKeysOutboundHttp } from "../../src/shell/outbound-http/operations";
import type { ErasureOperatorEnvironment } from "./contract";
import { operatorRequest } from "./internal/operator-request";
import type { AuthenticatedWebSession } from "../web-session/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { ErasureRequest } from "../../src/core/erasure/contract";
import { authenticateWebSession } from "../web-session/operations";
import { boundedJsonBody } from "../http/operations";
import { RequestBodyPolicy } from "../http/contract";
import { captureTraceHeaders } from "../runtime/telemetry/operations";
import { ErasureBrowserAdmission } from "./contract";
import { guardedDatabase } from "./internal/database";

/** Native entrypoints supply the required private registry binding in the deployed topology. Missing required configuration fails closed when a data unit executes. */
export const withErasureRecovery = <
  Environment extends Readonly<{ DB: D1Database }> &
    Partial<Readonly<{ ERASURE_REQUIRED: string; ERASURE_BUCKET: R2Bucket }>>,
>(
  environment: Environment
): Environment =>
  environment.ERASURE_REQUIRED === "true" || environment.ERASURE_BUCKET !== undefined
    ? {
        ...environment,
        DB: guardedDatabase({
          db: environment.DB,
          bucket: Option.fromUndefinedOr(environment.ERASURE_BUCKET),
        }),
      }
    : environment;

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
