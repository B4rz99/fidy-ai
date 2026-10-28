import { sweepGrants } from "./internal/cleanup";
import { digestBytes } from "../secret-material/operations";
import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
import { captureTraceHeaders } from "../runtime/telemetry/operations";
import { protectCanonicalPressure } from "../canonical-admission/operations";
import { Clock, Effect, Option, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import {
  type ConnectionBrowserApi,
  ConnectionContinuationInput,
} from "../../src/shell/connections/contract";
import { connectionBrowserTransport } from "../../src/shell/connections/runtime";
import { authenticateCanonicalWebSession } from "../web-session/operations";
import {
  ConnectionBrowserAdmission,
  ConnectionCallbackAdmission,
  ConnectionRetentionUnavailable,
  connectionCallbackPath,
} from "./contract";
import { continuationFailure, reviewContinuation } from "./internal/browser";
import { RequestBodyPolicy } from "../http/contract";
import { boundedJsonBody } from "../http/operations";
import type { AuthenticatedWebSession } from "../web-session/contract";

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
const attemptRetentionMilliseconds = 86400000;
const maximumRetentionRows = 128;

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
const callbackResult = (
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

/** Erase expired continuation metadata independently of User activity or current Consent. */
export const sweepConnectionAttempts = (
  input: Readonly<{ db: D1Database; current: number }>
): Effect.Effect<void, ConnectionRetentionUnavailable> =>
  Effect.tryPromise({
    try: () =>
      input.db.batch([
        input.db
          .prepare(`UPDATE connection_authorizations SET phase='failed',verifier=NULL,handoff_url=NULL WHERE attempt_id IN
      (SELECT b.attempt_id FROM connection_authorizations b JOIN connection_attempts a ON a.id=b.attempt_id JOIN connections c ON c.id=a.connection_id
      WHERE a.expires_at_ms<=? AND b.phase!='failed' AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=c.user_id AND q.state<>'Draining') LIMIT ?)`)
          .bind(input.current, maximumRetentionRows),
        input.db
          .prepare(`UPDATE connection_grants SET state='cleanup_required' WHERE attempt_id IN(
          SELECT g.attempt_id FROM connection_grants g JOIN connection_attempts a ON a.id=g.attempt_id JOIN connections c ON c.id=a.connection_id
          WHERE g.state IN ('claimed','quarantined') AND a.expires_at_ms<=?
          AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=c.user_id AND q.state<>'Draining') LIMIT ?)`)
          .bind(input.current, maximumRetentionRows),
        input.db
          .prepare(`UPDATE connections SET state='Action required' WHERE id IN(
          SELECT c.id FROM connections c JOIN connection_attempts a ON a.connection_id=c.id JOIN connection_grants g ON g.attempt_id=a.id
          WHERE c.state='Connecting' AND g.state='cleanup_required' AND a.expires_at_ms<=?
          AND NOT EXISTS(SELECT 1 FROM connection_attempts newer WHERE newer.connection_id=c.id AND newer.rowid>a.rowid)
          AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=c.user_id AND q.state<>'Draining') LIMIT ?)`)
          .bind(input.current, maximumRetentionRows),
        input.db
          .prepare(`DELETE FROM connection_attempts WHERE id IN
      (SELECT a.id FROM connection_attempts a WHERE expires_at_ms <= ?
        AND NOT EXISTS(SELECT 1 FROM connection_authorizations b WHERE b.attempt_id=a.id AND b.consent_id IS NOT NULL)
        ORDER BY expires_at_ms, id LIMIT ?)`)
          .bind(input.current - attemptRetentionMilliseconds, maximumRetentionRows),
      ]),
    catch: () => new ConnectionRetentionUnavailable(),
  }).pipe(Effect.asVoid);

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

/** Browser cookie is the only caller authority; neither URL nor bank handoff can establish identity. */
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

export const makeConnectionsErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));

/** Recover one due held grant per tick, with a durable lease and no new customer authorization. */
export const sweepConnectionGrants = (
  input: Parameters<typeof sweepGrants>[0]
): ReturnType<typeof sweepGrants> => sweepGrants(input);
