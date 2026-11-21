import { ConsentSubject } from "../../../src/shell/consent/contract";
import { Clock, Data, DateTime, Effect, Exit, Option, Predicate, Redacted, Schema } from "effect";
import { proofPolicy } from "../contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import {
  FrozenChannelApproval,
  channelInspectUrl,
  directoryName,
  localCallerUrl,
  registerSessionUrl,
  releaseSessionUrl,
} from "../../directory/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Hex } from "effect/encoding";
import { ProviderBrowserProof } from "../../../src/shell/provider-authentication/contract";
import { calculateWebSessionDeadlines } from "../../../src/core/web-session/operations";
import { decideBrowserLoginRedemption } from "../../../src/core/browser-login/operations";
import { digestVerifier, invalidPairing, unavailable } from "./proof";
import { newId, newSecret } from "../../secret-material/operations";
import { boundedJsonBody } from "../../http/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { sessionSetCookie } from "../../web-session/operations";
import { UserId } from "../../../src/core/identity/contract";

const isResponse = Schema.is(Schema.instanceOf(Response));

const maximumWrongProofs = 5;

const maximumPollSeconds = 60;

const claimLeaseMs = 30000;

const noContentStatus = 204;

const unauthorizedStatus = 401;

const missingStatus = 404;

class SessionActivationUnavailable extends Data.TaggedError("SessionActivationUnavailable") {}

const Ready = Schema.Struct({
  user_id: UserId,
  id: Schema.String,
  matches: Schema.Int,
  expires_at_ms: Schema.Int,
  wrong_attempts: Schema.Int,
  last_poll_ms: Schema.NullOr(Schema.Int),
  minimum_poll_seconds: Schema.Int,
  state: Schema.Literals(["ready", "invalidated", "consumed", "pending_approval"]),
});

const localLifecycle = (row: typeof Ready.Type): (typeof Ready.Type)["state"] =>
  row.wrong_attempts >= maximumWrongProofs ? "invalidated" : row.state;

const prepareClaim = Effect.fn(function* (
  { id, digest, session }: Readonly<{ id: string; digest: string; session: string }>,
  owns: (user: string) => boolean
) {
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;

  const [raw] =
    yield* sql`SELECT handoff.user_id,handoff.id,handoff.verifier_digest=${digest} AS matches,handoff.expires_at_ms,handoff.wrong_attempts,handoff.last_poll_ms,handoff.minimum_poll_seconds,handoff.state FROM browser_handoffs handoff JOIN users u ON u.id=handoff.user_id WHERE handoff.pairing_id=${id} AND handoff.outcome='committed' AND u.lifetime_registered=1 AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

  if (raw === undefined) return invalidPairing();
  const row = yield* Schema.decodeUnknownEffect(Ready)(raw);

  if (!owns(row.user_id)) return invalidPairing();

  const decision = decideBrowserLoginRedemption({
    lifecycle: localLifecycle(row),
    verifierMatches: row.matches === 1,
    expiresAt: DateTime.makeUnsafe(row.expires_at_ms),
    wrongVerifierAttempts: row.wrong_attempts,
    minimumPollIntervalSeconds: row.minimum_poll_seconds,
    lastAcceptedPollAt: Option.map(Option.fromNullishOr(row.last_poll_ms), (value) =>
      DateTime.makeUnsafe(value)
    ),
    attemptedAt: DateTime.makeUnsafe(current),
  });

  if (Predicate.isTagged(decision, "WrongVerifier")) {
    yield* sql`UPDATE browser_handoffs SET wrong_attempts=${decision.wrongVerifierAttempts},state=${decision.lifecycle} WHERE id=${row.id}`;

    return invalidPairing();
  }

  if (Predicate.isTagged(decision, "SlowDown")) {
    const retry = Math.min(maximumPollSeconds, decision.retryAfterSeconds);
    yield* sql`UPDATE browser_handoffs SET minimum_poll_seconds=${Math.min(maximumPollSeconds, decision.minimumPollIntervalSeconds)} WHERE id=${row.id}`;

    return Response.json(
      { error: { code: "rate_limited", retryAfterSeconds: retry } },
      { status: 429, headers: { "retry-after": String(retry), "cache-control": "no-store" } }
    );
  }

  if (Predicate.isTagged(decision, "Pending")) {
    yield* sql`UPDATE browser_handoffs SET last_poll_ms=${current} WHERE id=${row.id}`;

    return Response.json(
      {
        status: "pending_approval",
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(row.expires_at_ms)),
        pollingIntervalSeconds: decision.minimumPollIntervalSeconds,
      },
      { status: 202, headers: { "cache-control": "no-store" } }
    );
  }

  if (!Predicate.isTagged(decision, "Consume")) return invalidPairing();

  const changed =
    yield* sql`UPDATE browser_handoffs SET claim_id=${session},claim_at_ms=${current} WHERE id=${row.id} AND (claim_id IS NULL OR claim_at_ms<${current - claimLeaseMs}) RETURNING id`;

  if (changed.length === 0) return invalidPairing();

  return { user: row.user_id, attempt: row.id, current };
});

const sessionRoute = Effect.fn(function* (
  directory: Pick<DurableObjectNamespace, "getByName">,
  url: string,
  body: string
) {
  return yield* Effect.tryPromise((signal) =>
    directory.getByName(directoryName).fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    })
  );
});

export const redeemLocalPairing = Effect.fn(function* (
  request: Request,
  directory: Pick<DurableObjectNamespace, "getByName">,
  owns: (user: string) => boolean
) {
  const proof = yield* boundedJsonBody({
    request,
    policy: proofPolicy,
    schema: ProviderBrowserProof,
  });

  if (Option.isNone(proof)) return invalidPairing();
  const { pairingId, privateVerifier } = proof.value;
  const digest = yield* digestVerifier(privateVerifier);
  const token = Redacted.value(yield* newSecret);
  const tokenDigest = yield* digestVerifier(token);
  const sessionId = newId();

  const prepare = yield* prepareClaim({ id: pairingId, digest, session: sessionId }, owns).pipe(
    withStoreCapacity("required")
  );

  if (isResponse(prepare)) return prepare;
  const deadlines = calculateWebSessionDeadlines(DateTime.makeUnsafe(prepare.current));
  const hard = DateTime.toEpochMillis(deadlines.hardExpiresAt);

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    userId: prepare.user,
    sessionId,
    digest: tokenDigest,
    pairingId,
    attemptId: prepare.attempt,
    hard,
  });

  const sql = yield* SqliteClient;

  const discard = Effect.gen(function* () {
    const cancelled =
      yield* sql`UPDATE browser_handoffs SET claim_id=NULL,claim_at_ms=NULL WHERE id=${prepare.attempt} AND user_id=${prepare.user} AND pairing_id=${pairingId} AND claim_id=${sessionId} AND state<>'consumed' AND NOT EXISTS(SELECT 1 FROM web_sessions WHERE id=${sessionId}) RETURNING id`.pipe(
        withStoreCapacity("required")
      );

    if (cancelled.length === 1) yield* sessionRoute(directory, releaseSessionUrl, body);
  });

  const activate = Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;

    const changed =
      yield* sql`UPDATE browser_handoffs SET state='consumed' WHERE id=${prepare.attempt} AND outcome='committed' AND state='ready' AND user_id=${prepare.user} AND verifier_digest=${digest} AND expires_at_ms>${current} AND wrong_attempts<5 AND claim_id=${sessionId} AND NOT EXISTS(SELECT 1 FROM erasure_requests) RETURNING id`;

    if (changed.length !== 1) return invalidPairing();
    const bytes = yield* Effect.fromResult(Hex.decode(tokenDigest));

    const inserted =
      yield* sql`INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(${sessionId},${pairingId},${prepare.user},${bytes},${prepare.current},${DateTime.toEpochMillis(deadlines.freshUntil)},${DateTime.toEpochMillis(deadlines.idleExpiresAt)},${hard}) RETURNING id`;

    if (inserted.length !== 1) return yield* new SessionActivationUnavailable();

    return Response.json(
      { status: "authenticated" },
      { headers: { "cache-control": "no-store", "set-cookie": sessionSetCookie(token) } }
    );
  }).pipe(withStoreCapacity("growth"));

  return yield* sessionRoute(directory, registerSessionUrl, body).pipe(
    Effect.flatMap((registered) => (registered.ok ? activate : Effect.succeed(unavailable()))),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) && exit.value.ok ? Effect.void : discard.pipe(Effect.ignore)
    )
  );
});

export const localChannelRequest = Effect.fn(function* (
  request: Request,
  directory: Pick<DurableObjectNamespace, "getByName">,
  owns: (user: string) => boolean
) {
  const sql = yield* SqliteClient;

  if (request.url === localCallerUrl) {
    const caller = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ portfolio: Schema.String, bsuid: Schema.String })
    )(yield* Effect.tryPromise(() => request.json()));

    const [raw] =
      yield* sql`SELECT id FROM users WHERE whatsapp_portfolio_id=${caller.portfolio} AND whatsapp_bsuid=${caller.bsuid} AND lifetime_registered=1 AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

    return new Response(null, {
      status:
        raw !== undefined && owns(yield* Schema.decodeUnknownEffect(UserId)(raw.id))
          ? noContentStatus
          : unauthorizedStatus,
    });
  }

  const id = yield* Effect.tryPromise(() => request.text());

  const res = yield* Effect.tryPromise((signal) =>
    directory
      .getByName(directoryName)
      .fetch(channelInspectUrl, { method: "POST", body: id, signal })
  );

  if (!res.ok) return res.status === missingStatus ? invalidPairing() : unavailable();

  const handoff = yield* Schema.decodeUnknownEffect(FrozenChannelApproval)(
    yield* Effect.tryPromise(() => res.json())
  );

  if (!owns(handoff.user_id) || handoff.id !== id) return invalidPairing();

  return yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const standing = protectConsentStatement({
      statement: {
        sql: "SELECT 1 FROM users u WHERE u.id=? AND u.whatsapp_portfolio_id=? AND u.whatsapp_bsuid=? AND u.lifetime_registered=1 AND NOT EXISTS(SELECT 1 FROM erasure_requests)",
        params: [handoff.user_id, handoff.portfolio, handoff.bsuid],
      },
      subject: ConsentSubject.User({ userId: handoff.user_id }),
      requirement: "granted",
    });

    if (
      (yield* sql.unsafe(standing.sql, standing.params)).length !== 1 ||
      handoff.expires_at_ms <= now ||
      handoff.wrong_attempts >= maximumWrongProofs
    ) {
      return invalidPairing();
    }

    const [prior] =
      yield* sql`SELECT outcome FROM browser_handoffs WHERE id=${handoff.id} AND pairing_id=${handoff.pairing_id} AND user_id=${handoff.user_id}`;

    if (prior !== undefined) {
      return prior.outcome === "committed" ? new Response(null, { status: 204 }) : invalidPairing();
    }

    const [later] =
      yield* sql`SELECT 1 FROM browser_handoffs WHERE state='ready' AND wrong_attempts<5 AND expires_at_ms>${now} AND ordinal>${handoff.ordinal} LIMIT 1`;

    if (later !== undefined) return invalidPairing();
    yield* sql`UPDATE browser_handoffs SET state='invalidated' WHERE state='ready' AND ordinal<${handoff.ordinal}`;
    yield* sql`INSERT INTO browser_handoffs(id,pairing_id,user_id,ordinal,verifier_digest,expires_at_ms,wrong_attempts,last_poll_ms,minimum_poll_seconds,outcome,state) VALUES(${handoff.id},${handoff.pairing_id},${handoff.user_id},${handoff.ordinal},${handoff.verifier_digest},${handoff.expires_at_ms},${handoff.wrong_attempts},${handoff.last_poll_ms},${handoff.minimum_poll_seconds},'committed','ready')`;

    return new Response(null, { status: 204 });
  }).pipe(withStoreCapacity("growth"));
});
