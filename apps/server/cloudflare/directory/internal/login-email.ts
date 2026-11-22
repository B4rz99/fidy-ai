import { Clock, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  CompleteBrowserPairingEmailAuthenticationPayload as Complete,
  StartBrowserPairingEmailAuthenticationPayload as Start,
  browserPairingEmailAuthenticationInvalidBody,
} from "../../../src/shell/email-authentication/contract";
import {
  LoginEmailHandoff,
  LoginMailboxCandidate,
  loginCheckUrl,
  loginStartUrl,
  loginVerifyUrl,
} from "../../email-authentication/contract";
import { boundedJsonBody } from "../../http/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { digestVerifier } from "../../browser-login/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import { findMailboxRoute } from "./replacement";

const isResponse = Schema.is(Schema.instanceOf(Response));

const hour = 3600000,
  sharedLimit = 1000,
  wrongLimit = 5;

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 512,
  deadlineMilliseconds: 2000,
});

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const invalidStatus = 400,
  pendingStatus = 202,
  allowedStatus = 204,
  throttledStatus = 429,
  missingStatus = 404;

const invalid = (): Response => json(browserPairingEmailAuthenticationInvalidBody, invalidStatus);

const pending = (): Response => json({ status: "pending", retryAfterSeconds: 60 }, pendingStatus);

export const chargeLoginAttempt = Effect.gen(function* () {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const charged =
    yield* sql`INSERT INTO login_email_window VALUES(1,${now + hour},1) ON CONFLICT(singleton) DO UPDATE SET reset_at_ms=CASE WHEN reset_at_ms<=${now} THEN excluded.reset_at_ms ELSE reset_at_ms END, used=CASE WHEN reset_at_ms<=${now} THEN 1 ELSE used+1 END WHERE reset_at_ms<=${now} OR used<${sharedLimit} RETURNING 1`;

  return new Response(null, { status: charged.length === 1 ? allowedStatus : throttledStatus });
}).pipe(withStoreCapacity("required"));

type Input = Start | Complete;

type Users = Pick<DurableObjectNamespace, "getByName">;

const binding = Effect.fn(function* (input: Input, digest: string) {
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  const [raw] =
    yield* sql`SELECT user_id,email_handoff,verifier_digest=${digest} AS matches FROM browser_pairings WHERE id=${input.pairingId} AND expires_at_ms>${now} AND wrong_attempts<${wrongLimit}`;

  if (raw === undefined) return invalid();

  if (raw.user_id !== null) return raw.email_handoff === null ? invalid() : ("bound" as const);

  if (raw.matches === 1) return "unbound" as const;
  yield* sql`UPDATE browser_pairings SET wrong_attempts=wrong_attempts+1 WHERE id=${input.pairingId} AND user_id IS NULL`;

  return invalid();
});

const bind = Effect.fn(function* (input: Start, digest: string, users: Users) {
  const route = yield* findMailboxRoute(input.email);

  if (route === null) return pending();

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(LoginMailboxCandidate))({
    ...route,
    address: input.email,
  });

  const checked = yield* Effect.tryPromise((signal) =>
    users.getByName(route.user_id).fetch(loginCheckUrl, { method: "POST", body, signal })
  );

  if (checked.status === missingStatus) return pending();

  if (checked.status !== allowedStatus) return new Response(null, { status: 503 });
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const candidate = yield* findMailboxRoute(input.email);

    if (candidate?.user_id !== route.user_id || candidate.revision !== route.revision) {
      return pending();
    }

    yield* sql`UPDATE browser_pairings SET email_handoff=${newId()},user_id=${route.user_id} WHERE id=${input.pairingId} AND user_id IS NULL AND verifier_digest=${digest} AND expires_at_ms>${now} AND wrong_attempts<5`;

    return null;
  }).pipe(withStoreCapacity("growth"));
});

const currentMailboxRevision = Effect.fn(function* (input: Input, user: string) {
  if (!("email" in input)) return null;
  const route = yield* findMailboxRoute(input.email);

  return route?.user_id === user ? route.revision : null;
});

const freeze = Effect.fn(function* (input: Input, digest: string, users: Users) {
  const mode = yield* binding(input, digest).pipe(withStoreCapacity("required"));

  if (isResponse(mode)) return mode;

  if (mode === "unbound") {
    if (!("email" in input)) return invalid();
    const refused = yield* bind(input, digest, users);

    if (refused !== null) return refused;
  }

  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT email_handoff AS id,id AS pairing_id,user_id,ordinal,verifier_digest,expires_at_ms,wrong_attempts,last_poll_ms,minimum_poll_seconds FROM browser_pairings WHERE id=${input.pairingId} AND email_handoff IS NOT NULL`;

  if (row === undefined) return invalid();
  const handoff = yield* Schema.decodeUnknownEffect(LoginEmailHandoff)(row);

  return { handoff, digest, revision: yield* currentMailboxRevision(input, handoff.user_id) };
});

export const directoryLoginEmail = Effect.fn(function* (
  request: Request,
  users: Pick<DurableObjectNamespace, "getByName">
) {
  const complete = new URL(request.url).pathname.endsWith("/complete");

  const proof = complete
    ? yield* boundedJsonBody({ request, policy, schema: Complete })
    : yield* boundedJsonBody({ request, policy, schema: Start });

  if (Option.isNone<Input>(proof)) return invalid();
  const input = proof.value;
  const frozen = yield* freeze(input, yield* digestVerifier(input.privateVerifier), users);

  if (isResponse(frozen)) return frozen;
  const recipient = "email" in input ? { address: input.email } : { code: input.combinedCode };

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    ...frozen,
    ...recipient,
  });

  return yield* Effect.tryPromise((signal) =>
    users
      .getByName(frozen.handoff.user_id)
      .fetch(complete ? loginVerifyUrl : loginStartUrl, { method: "POST", body, signal })
  );
});
