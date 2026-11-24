import { proofPolicy } from "../../browser-login/contract";
import { invitationStatus } from "./whatsapp";
import { chargeBootstrapWindows } from "./admission";
import { Clock, Effect, Option, Result, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  type AuthenticationProvider,
  ProviderCompletionProof,
  StartProviderAuthentication,
  microsoftProviderPaths,
  providerPaths,
} from "../../../src/shell/provider-authentication/contract";
import { webSignupDisclosure } from "../../../src/shell/consent/operations";
import { boundedJsonBody } from "../../http/operations";
import { digestBytes, newId } from "../../secret-material/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import {
  callbackRedirect,
  cookieVerifier,
  prepareAttempt,
  providerConfiguration,
  providerRejectionReason,
  startedResponse,
  validCode,
  validateGoogleToken,
  validateMicrosoftToken,
} from "../../provider-authentication/operations";
import type { ProviderConfiguration } from "../../provider-authentication/contract";
import { DirectoryWriteUnavailable, FrozenBrowserHandoff, bootstrapCompleteUrl } from "../contract";
import { digestVerifier, invalidProvider, unavailable } from "../../browser-login/operations";

type Environment = ProviderConfiguration &
  Readonly<{ USER_STORE: Pick<DurableObjectNamespace, "getByName"> }>;

const isResponse = Schema.is(Schema.instanceOf(Response));

const json = (body: unknown): Response =>
  Response.json(body, {
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

const proveUnbound = Effect.fn(function* (id: string, verifier: string) {
  const digest = yield* digestVerifier(verifier);
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;

  const [row] =
    yield* sql`SELECT expires_at_ms FROM browser_pairings WHERE id=${id} AND verifier_digest=${digest} AND user_id IS NULL AND expires_at_ms>${current} AND wrong_attempts<5`;

  if (row === undefined) {
    yield* sql`UPDATE browser_pairings SET wrong_attempts=wrong_attempts+1 WHERE id=${id} AND user_id IS NULL AND verifier_digest<>${digest} AND wrong_attempts<5 AND expires_at_ms>${current}`;

    return Option.none<number>();
  }

  return Option.some(yield* Schema.decodeUnknownEffect(Schema.Int)(row.expires_at_ms));
});

const start = Effect.fn(function* (
  request: Request,
  environment: Environment,
  provider: AuthenticationProvider
) {
  if (!providerConfiguration({ environment, provider }).configured) return unavailable();

  const input = yield* boundedJsonBody({
    request,
    policy: proofPolicy,
    schema: StartProviderAuthentication,
  });

  if (Option.isNone(input)) return invalidProvider();
  const { pairingId, privateVerifier, intent, consentRevision, handoffReference } = input.value;
  const disclosure = webSignupDisclosure();

  if (intent === "signup" && consentRevision !== disclosure.revision) return invalidProvider();
  const prepared = yield* prepareAttempt(disclosure);
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const proof = yield* proveUnbound(pairingId, privateVerifier);

    if (Option.isNone(proof)) return invalidProvider();

    if (handoffReference !== undefined) {
      const claim =
        yield* sql`UPDATE whatsapp_invitations SET pairing_id=${pairingId},review_code=NULL,review_attempt=NULL,review_text=NULL,review_started_ms=NULL,decision=NULL,confirmed_ms=NULL,decision_message=NULL WHERE id=${handoffReference} AND (pairing_id IS NULL OR pairing_id=${pairingId}) AND expires_at_ms>${prepared.current} RETURNING id`;

      if (claim.length !== 1) return invalidProvider();
    }

    yield* sql`INSERT INTO provider_attempts(id,pairing_id,invitation,provider,cookie_digest,nonce,intent,disclosure,accepted_at_ms,expires_at_ms,state) VALUES(${prepared.state},${pairingId},${handoffReference ?? null},${provider},${prepared.challenge},${prepared.nonce},${intent},${intent === "signup" ? prepared.snapshot : null},${intent === "signup" ? prepared.current : null},${proof.value},'pending') ON CONFLICT(pairing_id) DO UPDATE SET id=excluded.id,invitation=excluded.invitation,provider=excluded.provider,cookie_digest=excluded.cookie_digest,nonce=excluded.nonce,intent=excluded.intent,disclosure=excluded.disclosure,accepted_at_ms=excluded.accepted_at_ms,expires_at_ms=excluded.expires_at_ms,state='pending',issuer=NULL,subject=NULL,contact_email=NULL`;

    return startedResponse({ environment, provider, ...prepared });
  }).pipe(withStoreCapacity("growth"));
});

const callbackState = (query: URLSearchParams): string => query.get("state") ?? "";

const validCallbackState = (query: URLSearchParams, state: string, configured: boolean): boolean =>
  configured && /^[A-Za-z0-9_-]{43}$/u.test(state) && query.getAll("state").length === 1;

const callback = Effect.fn(function* (
  request: Request,
  environment: Environment,
  provider: AuthenticationProvider
) {
  const config = providerConfiguration({ environment, provider });
  const query = new URL(request.url).searchParams;
  const id = callbackState(query);
  const verifier = cookieVerifier({ request, cookieName: config.cookieName });

  if (!validCallbackState(query, id, config.configured) || Option.isNone(verifier)) {
    return callbackRedirect({ environment, provider, clearCookie: false });
  }

  const digest = yield* digestBytes(new TextEncoder().encode(verifier.value));
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;

  const [row] =
    yield* sql`UPDATE provider_attempts SET state='exchanging' WHERE id=${id} AND cookie_digest=${digest} AND provider=${provider} AND expires_at_ms>${current} AND state='pending' RETURNING id,nonce,expires_at_ms`;

  if (row === undefined) return callbackRedirect({ environment, provider, clearCookie: false });

  const attempt = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ id: Schema.String, nonce: Schema.String, expires_at_ms: Schema.Int })
  )(row);

  const evidence = { environment, provider, query, attempt, verifier: verifier.value };

  const result = yield* Effect.result(
    Effect.gen(function* () {
      if (!validCode(query)) return yield* Effect.fail("invalid");

      if (provider === "google") {
        return yield* Effect.timeout(validateGoogleToken(evidence), "10 seconds");
      }

      return yield* Effect.timeout(validateMicrosoftToken(evidence), "10 seconds");
    })
  );

  if (Result.isSuccess(result)) {
    const settled = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE provider_attempts SET state='verified',issuer=${result.success.issuer},subject=${result.success.subject},contact_email=${Option.getOrNull(result.success.contactEmail)},expires_at_ms=MIN(expires_at_ms,${result.success.expiresAtMs}) WHERE id=${id} AND state='exchanging' AND expires_at_ms>${settled}`;
  } else {
    yield* Effect.log({
      component: "api",
      operation: "provider.authentication",
      provider,
      reason: providerRejectionReason(result.failure),
    });
    yield* sql`UPDATE provider_attempts SET state='rejected' WHERE id=${id} AND state='exchanging'`;
  }

  return callbackRedirect({ environment, provider, clearCookie: true });
});

export const inspectHandoff = Effect.fn(function* (id: string) {
  const sql = yield* SqliteClient;

  const [raw] =
    yield* sql`SELECT p.user_id,attempt.id,p.id AS pairing_id,p.ordinal,p.verifier_digest,p.expires_at_ms AS pairing_expires_at_ms,attempt.expires_at_ms,p.wrong_attempts,p.last_poll_ms,p.minimum_poll_seconds,attempt.issuer,attempt.subject,attempt.contact_email,r.creation_attempt,r.established,attempt.disclosure,attempt.accepted_at_ms,attempt.intent,attempt.invitation,i.portfolio,i.bsuid,i.endpoint,i.review_code,i.review_attempt,i.review_text,i.decision,i.decision_message,i.confirmed_ms,i.expires_at_ms AS invitation_expiry FROM provider_attempts attempt LEFT JOIN whatsapp_invitations i ON i.id=attempt.invitation AND i.pairing_id=attempt.pairing_id JOIN browser_pairings p ON p.id=attempt.pairing_id JOIN provider_routes r ON r.issuer=attempt.issuer AND r.subject=attempt.subject AND r.user_id=p.user_id WHERE attempt.id=${id} AND attempt.state='bound'`;

  return yield* Schema.decodeUnknownEffect(Schema.NullOr(FrozenBrowserHandoff))(raw ?? null);
});

const requireWrite = (
  rows: ReadonlyArray<unknown>
): Effect.Effect<void, DirectoryWriteUnavailable> =>
  rows.length === 1 ? Effect.void : Effect.fail(new DirectoryWriteUnavailable());

const Attempt = Schema.Struct({
  id: Schema.String,
  intent: Schema.String,
  state: Schema.String,
  invitation: Schema.NullOr(Schema.String),
  issuer: Schema.NullOr(Schema.String),
  subject: Schema.NullOr(Schema.String),
  user_id: Schema.NullOr(Schema.String),
});

const checkedInvitation = Effect.fn(function* (
  attempt: typeof Attempt.Type,
  proof: typeof ProviderCompletionProof.Type
) {
  const sql = yield* SqliteClient;
  const { pairingId } = proof;

  const [invitation] =
    attempt.invitation === null
      ? []
      : yield* sql`SELECT portfolio,bsuid FROM whatsapp_invitations WHERE id=${attempt.invitation} AND pairing_id=${pairingId} AND review_attempt=${attempt.id} AND review_code=${proof.associationCode ?? ""} AND decision='confirmed' AND length(decision_message)>0 AND length(review_text)>0 AND review_started_ms<confirmed_ms AND confirmed_ms<expires_at_ms AND expires_at_ms>${yield* Clock.currentTimeMillis}`;

  if (attempt.invitation !== null && invitation === undefined) return { valid: false as const };

  if (invitation !== undefined) {
    const occupied =
      yield* sql`SELECT 1 FROM whatsapp_routes WHERE portfolio=${invitation.portfolio} AND bsuid=${invitation.bsuid} OR user_id IN(SELECT user_id FROM provider_routes WHERE issuer=${attempt.issuer} AND subject=${attempt.subject}) LIMIT 1`;

    if (occupied.length > 0) return { valid: false as const };
  }

  return { valid: true as const, invitation };
});

const verifiedSubject = (attempt: typeof Attempt.Type): boolean =>
  attempt.state === "verified" && attempt.issuer !== null && attempt.subject !== null;

const reserveProvider = Effect.fn(function* (
  attempt: typeof Attempt.Type,
  proof: typeof ProviderCompletionProof.Type
) {
  const sql = yield* SqliteClient;
  const { pairingId } = proof;

  if (!verifiedSubject(attempt)) {
    return invalidProvider();
  }

  const checked = yield* checkedInvitation(attempt, proof);

  if (!checked.valid) return invalidProvider();
  const { invitation } = checked;

  if (attempt.intent === "signup") {
    yield* sql`INSERT INTO provider_routes(issuer,subject,user_id,creation_attempt) VALUES(${attempt.issuer},${attempt.subject},${newId()},${attempt.id}) ON CONFLICT DO NOTHING`;
  }

  const [route] =
    yield* sql`SELECT r.user_id,r.creation_attempt,r.established FROM provider_routes r
      WHERE r.issuer=${attempt.issuer} AND r.subject=${attempt.subject}
      AND NOT EXISTS(SELECT 1 FROM erasure_barriers b WHERE b.user_id=r.user_id)`;

  if (route === undefined) return invalidProvider();

  if (route.creation_attempt !== attempt.id && route.established !== 1) return unavailable();
  const user = yield* Schema.decodeUnknownEffect(Schema.String)(route.user_id);

  if (invitation !== undefined) {
    yield* requireWrite(
      yield* sql`INSERT INTO whatsapp_routes(portfolio,bsuid,user_id,attempt_id) VALUES(${invitation.portfolio},${invitation.bsuid},${user},${attempt.id}) RETURNING 1`
    );
  }

  yield* requireWrite(
    yield* sql`UPDATE browser_pairings SET user_id=${user} WHERE id=${pairingId} AND user_id IS NULL RETURNING 1`
  );
  yield* requireWrite(
    yield* sql`UPDATE provider_attempts SET state='bound',cookie_digest=zeroblob(32),nonce='' WHERE id=${attempt.id} AND state='verified' RETURNING 1`
  );

  return { user, id: attempt.id };
});

const prepareHandoff = Effect.fn(function* (
  proof: typeof ProviderCompletionProof.Type,
  provider: AuthenticationProvider,
  complete: boolean
) {
  const sql = yield* SqliteClient;
  const { pairingId } = proof;

  const [raw] =
    yield* sql`SELECT attempt.id,attempt.intent,attempt.state,attempt.issuer,attempt.subject,attempt.invitation,p.user_id FROM provider_attempts attempt JOIN browser_pairings p ON p.id=attempt.pairing_id WHERE attempt.pairing_id=${pairingId} AND attempt.provider=${provider} AND NOT EXISTS(SELECT 1 FROM erasure_barriers WHERE user_id=p.user_id) AND attempt.expires_at_ms>${yield* Clock.currentTimeMillis}`;

  if (raw === undefined) return invalidProvider();
  const attempt = yield* Schema.decodeUnknownEffect(Attempt)(raw);

  if (attempt.user_id !== null) return { user: attempt.user_id, id: attempt.id };

  if (Option.isNone(yield* proveUnbound(proof.pairingId, proof.privateVerifier))) {
    return invalidProvider();
  }

  if (complete) return yield* reserveProvider(attempt, proof);

  if (attempt.invitation !== null && attempt.state === "verified") {
    return yield* invitationStatus(attempt.invitation, proof.pairingId, attempt.id);
  }

  return json({
    status: ["verified", "rejected"].includes(attempt.state) ? attempt.state : "pending",
  });
});

const routeProvider = Effect.fn(function* (
  request: Request,
  environment: Environment,
  { provider, complete }: Readonly<{ provider: AuthenticationProvider; complete: boolean }>
) {
  const proof = yield* boundedJsonBody({
    request,
    policy: proofPolicy,
    schema: ProviderCompletionProof,
  });

  if (Option.isNone(proof)) return invalidProvider();
  const { privateVerifier } = proof.value;

  if (!complete) {
    const refusal = yield* chargeBootstrapWindows([
      { scope: "poll:" + (yield* digestVerifier(privateVerifier)), limit: 5, duration: 5000 },
    ]);

    if (Option.isSome(refusal)) return refusal.value;
  }

  const sql = yield* SqliteClient;

  const result = yield* prepareHandoff(proof.value, provider, complete).pipe(
    withStoreCapacity(complete ? "growth" : "required")
  );

  if (isResponse(result)) return result;

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    ...proof.value,
    id: result.id,
  });

  const response = yield* Effect.tryPromise((signal) =>
    environment.USER_STORE.getByName(result.user).fetch(
      complete ? bootstrapCompleteUrl : "https://user.invalid/bootstrap/status",
      { method: "POST", headers: { "content-type": "application/json" }, body, signal }
    )
  ).pipe(Effect.result);

  if (complete) {
    const fenced = yield* sql.withTransaction(
      Effect.gen(function* () {
        if ((yield* sql`SELECT 1 FROM erasure_barriers WHERE user_id=${result.user}`).length > 0) {
          return true;
        }

        if (Result.isFailure(response) || !response.success.ok) return false;
        yield* sql`UPDATE provider_attempts SET acknowledged=1 WHERE id=${result.id} AND state='bound'`;
        yield* sql`UPDATE provider_routes SET established=1 WHERE creation_attempt=${result.id} AND user_id=${result.user}`;
        yield* sql`UPDATE whatsapp_routes SET established=1 WHERE attempt_id=${result.id} AND user_id=${result.user}`;

        return false;
      })
    );

    if (fenced) return invalidProvider();
  }

  return yield* Effect.fromResult(response);
});

const getProvider = Effect.fn(function* (
  request: Request,
  environment: Environment,
  provider: AuthenticationProvider
) {
  const path = new URL(request.url).pathname;
  const paths = provider === "google" ? providerPaths : microsoftProviderPaths;

  if (path === providerPaths.disclosure) {
    const { text, revision, policy } = webSignupDisclosure();

    return json({ text, revision, policy: { publicUrl: policy.publicUrl } });
  }

  if (path === paths.callback) {
    return yield* callback(request, environment, provider);
  }

  return invalidProvider();
});

export const providerRequest = Effect.fn(function* (request: Request, environment: Environment) {
  const path = new URL(request.url).pathname;
  const provider = path.includes("microsoft") ? "microsoft" : "google";
  const paths = provider === "google" ? providerPaths : microsoftProviderPaths;

  if (request.method === "GET") return yield* getProvider(request, environment, provider);

  if (request.method !== "POST") return invalidProvider();

  if (path === paths.start) return yield* start(request, environment, provider);

  return yield* routeProvider(request, environment, {
    provider,
    complete: path === paths.complete,
  });
});
