import { protectCanonicalPressure } from "../canonical-admission/operations";
import { Clock, Effect, Option, Schema } from "effect";
import {
  ConnectionContinuationInput,
  connectionBrowserPaths,
} from "../../src/shell/connections/contract";
import { authenticateCanonicalWebSession } from "../web-session/operations";
import { ConnectionBrowserAdmission, ConnectionRetentionUnavailable } from "./contract";
import { continuationFailure, reviewContinuation } from "./internal/browser";
import { RequestBodyPolicy } from "../http/contract";
import { boundedJsonBody } from "../http/operations";
import type { AuthenticatedWebSession } from "../web-session/contract";

const forbiddenStatus = 403;
const methodNotAllowedStatus = 405;
const invalidStatus = 400;
const unauthenticatedStatus = 401;
const unavailableStatus = 503;
const maximumBytes = 1024;
const readDeadlineMilliseconds = 2000;
const admissionLifetimeMilliseconds = 5000;
const attemptRetentionMilliseconds = 86400000;
const maximumRetentionRows = 128;

/** Erase expired continuation metadata independently of User activity or current Consent. */
export const sweepConnectionAttempts = (
  input: Readonly<{ db: D1Database; current: number }>
): Effect.Effect<void, ConnectionRetentionUnavailable> =>
  Effect.tryPromise({
    try: () =>
      input.db
        .prepare(`DELETE FROM connection_attempts WHERE id IN
      (SELECT id FROM connection_attempts WHERE expires_at_ms <= ? ORDER BY expires_at_ms, id LIMIT ?)`)
        .bind(input.current - attemptRetentionMilliseconds, maximumRetentionRows)
        .run(),
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
    return yield* Effect.tryPromise(() =>
      input.coordinator.getByName(subject.userId).fetch(
        new Request("https://coordinator.internal/connection-begin", {
          method: "POST",
          body,
          signal: input.request.signal,
        })
      )
    );
  }).pipe(Effect.orElseSucceed(() => continuationFailure(unavailableStatus)));

const admittedBrowserRequest = (
  input: BrowserRequest,
  subject: AuthenticatedWebSession,
  review: boolean
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (!review) return yield* forwardBegin(input, subject);
    const parsed = reviewInput(input.request);
    if (Option.isNone(parsed)) return continuationFailure(invalidStatus);
    return yield* reviewContinuation({
      db: input.db,
      subject,
      attempt: parsed.value.attempt,
      current: yield* Clock.currentTimeMillis,
    });
  });

/** Browser cookie is the only caller authority; neither URL nor bank handoff can establish identity. */
export const handleConnectionBrowserRequest = (input: BrowserRequest): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (input.request.headers.get("origin") !== input.browserOrigin) {
      return continuationFailure(forbiddenStatus);
    }
    const review = new URL(input.request.url).pathname === connectionBrowserPaths.review;
    if (input.request.method !== (review ? "GET" : "POST")) {
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
      work: admittedBrowserRequest(input, session.value, review),
      refused: (response) => Effect.succeed(continuationFailure(response.status)),
    });
  }).pipe(Effect.orElseSucceed(() => continuationFailure(unavailableStatus)));
