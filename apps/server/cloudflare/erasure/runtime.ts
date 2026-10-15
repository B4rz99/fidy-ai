import { HttpClient } from "effect/http";
import { makeAccessSigningKeysOutboundHttp } from "../../src/shell/outbound-http/operations";
import type { ErasureOperatorEnvironment } from "./contract";
import { operatorRequest } from "./internal/operator-request";
import type { AuthenticatedWebSession } from "../web-session/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { ErasureReceipt, ErasureRequest } from "../../src/core/erasure/contract";
import { webSessionCredentialAuthority } from "../../src/shell/web-session/operations";
import { authenticateWebSession } from "../web-session/operations";
import { boundedJsonBody } from "../http/operations";
import { RequestBodyPolicy } from "../http/contract";
import { newId } from "../secret-material/operations";
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

const forbiddenStatus = 403;
const methodStatus = 405;
const invalidStatus = 400;
const unauthenticatedStatus = 401;
const conflictStatus = 409;
const unavailableStatus = 503;
const reply = (status: number): Response =>
  Response.json(
    { error: "erasure-unavailable" },
    { status, headers: { "cache-control": "no-store" } }
  );

const receive = (
  input: Readonly<{
    db: D1Database;
    subject: AuthenticatedWebSession;
    current: number;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { subject, current } = input;
    const proof = webSessionCredentialAuthority({ subject, current });
    const reference = yield* Effect.sync(newId);
    const results = yield* Effect.tryPromise(() =>
      input.db.batch([
        input.db
          .prepare(`INSERT INTO erasure_requests(id,user_id,requested_at_ms,state)
        SELECT ?,?,?,'AwaitingReview' WHERE EXISTS(SELECT 1 FROM ${proof.table}
        WHERE ${proof.predicate} AND fresh_until_ms>?) ON CONFLICT(user_id) DO NOTHING`)
          .bind(reference, subject.userId, current, ...proof.bindings, current),
        input.db
          .prepare(`SELECT id AS reference,state,'operator-review' AS next FROM erasure_requests
        WHERE user_id=? AND EXISTS(SELECT 1 FROM ${proof.table}
        WHERE ${proof.predicate} AND fresh_until_ms>?)`)
          .bind(subject.userId, ...proof.bindings, current),
      ])
    );
    const row = results[1]?.results[0];
    if (row === undefined) return reply(conflictStatus);
    const receipt = yield* Schema.decodeUnknownEffect(ErasureReceipt)(row);
    return Response.json(receipt, { status: 202, headers: { "cache-control": "no-store" } });
  }).pipe(Effect.orElseSucceed(() => reply(unavailableStatus)));

export const handleErasureRequest = (
  input: Readonly<{
    db: D1Database;
    request: Request;
    browserOrigin: string;
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
      db: input.db,
      subject: subject.value,
      current,
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
