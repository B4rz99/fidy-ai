import { proofPolicy } from "../../browser-login/contract";
import { Hex } from "effect/encoding";
import { Clock, Data, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DisclosureSnapshot } from "../../../src/core/consent/contract";
import { webSignupDisclosure } from "../../../src/shell/consent/operations";
import {
  ProviderCompletionProof,
  fidyWhatsAppUrl,
} from "../../../src/shell/provider-authentication/contract";
import { BrowserLoginPairingId } from "../../../src/core/browser-login/contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { registerUserLifetime } from "./registration";
import {
  FrozenBrowserHandoff,
  bootstrapCancelUrl,
  bootstrapCompleteUrl,
  directoryName,
  handoffInspectUrl,
  reserveRecoveryUrl,
} from "../../directory/contract";
import { boundedJsonBody } from "../../http/operations";
import { digestVerifier, invalidProvider, unavailable } from "../../browser-login/operations";
import { recoveryCodeDigest, sampleRecoveryCode } from "../../recovery/operations";

const trialLengthMs = 604800000;

const missingStatus = 404;

const ImportProof = Schema.Struct({ ...ProviderCompletionProof.fields, id: Schema.String });

const accepted = (): Response =>
  Response.json({ status: "approved" }, { headers: { "cache-control": "no-store" } });

type Handoff = typeof FrozenBrowserHandoff.Type;

const importHandoff = Effect.fn(function* (handoff: Handoff) {
  const sql = yield* SqliteClient;

  const evidence = yield* Schema.encodeEffect(Schema.fromJsonString(FrozenBrowserHandoff))({
    ...handoff,
    established: 0,
  });

  yield* sql`INSERT INTO browser_handoffs(id,pairing_id,user_id,ordinal,verifier_digest,expires_at_ms,wrong_attempts,last_poll_ms,minimum_poll_seconds,outcome,state,evidence_json) VALUES(${handoff.id},${handoff.pairing_id},${handoff.user_id},${handoff.ordinal},${handoff.verifier_digest},${handoff.pairing_expires_at_ms},${handoff.wrong_attempts},${handoff.last_poll_ms},${handoff.minimum_poll_seconds},'pending','pending_approval',${evidence}) ON CONFLICT(id) DO NOTHING`;
});

const checkHandoff = Effect.fn(function* (handoff: Handoff, digest: string, now: number) {
  const sql = yield* SqliteClient;

  const evidence = yield* Schema.encodeEffect(Schema.fromJsonString(FrozenBrowserHandoff))({
    ...handoff,
    established: 0,
  });

  const [raw] =
    yield* sql`SELECT outcome,verifier_digest=${digest} AS matches FROM browser_handoffs WHERE id=${handoff.id} AND pairing_id=${handoff.pairing_id} AND user_id=${handoff.user_id} AND ordinal=${handoff.ordinal} AND evidence_json=${evidence} AND expires_at_ms>${now} AND wrong_attempts<5 AND outcome<>'cancelled' AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

  if (raw === undefined || handoff.expires_at_ms <= now) return "invalid" as const;

  if (raw.matches !== 1) {
    yield* sql`UPDATE browser_handoffs SET wrong_attempts=wrong_attempts+1 WHERE id=${handoff.id} AND wrong_attempts<5`;

    return "invalid" as const;
  }

  return raw.outcome === "committed" ? ("committed" as const) : ("pending" as const);
});

class BootstrapCommitUnavailable extends Data.TaggedError("BootstrapCommitUnavailable") {}

const requireWrite = (
  rows: ReadonlyArray<unknown>
): Effect.Effect<void, BootstrapCommitUnavailable> =>
  rows.length === 1 ? Effect.void : Effect.fail(new BootstrapCommitUnavailable());

type Recovery = Readonly<{
  code: ReturnType<typeof sampleRecoveryCode>;
  recoveryDigest: Uint8Array;
  generation: number;
}>;

type Environment = Readonly<{
  DIRECTORY: Pick<DurableObjectNamespace, "getByName">;
  MAINTENANCE: Pick<DurableObjectNamespace, "getByName">;
}>;

const establishUser = Effect.fn(function* (
  handoff: Handoff,
  now: number,
  { recoveryDigest, generation }: Recovery
) {
  const sql = yield* SqliteClient;

  const exact =
    yield* sql`SELECT 1 FROM browser_handoffs WHERE id=${handoff.id} AND recovery_generation=${generation} AND recovery_generation>0`;

  if (exact.length !== 1) return false;

  if (
    handoff.creation_attempt !== handoff.id ||
    handoff.established !== 0 ||
    handoff.intent !== "signup" ||
    handoff.disclosure === null ||
    handoff.accepted_at_ms === null
  ) {
    return false;
  }

  const disclosure = yield* Schema.decodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
    handoff.disclosure
  );

  if (disclosure.revision !== webSignupDisclosure().revision) return false;
  yield* requireWrite(
    yield* sql`INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms,lifetime_registered) VALUES(${handoff.user_id},'CO','es-CO','America/Bogota',${now},${now},${now + trialLengthMs},1) RETURNING 1`
  );
  yield* requireWrite(
    yield* sql`INSERT INTO provider_credentials(issuer,subject,user_id,contact_email,established_at_ms) VALUES(${handoff.issuer},${handoff.subject},${handoff.user_id},${handoff.contact_email},${now}) RETURNING 1`
  );
  yield* requireWrite(
    yield* sql`INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms) VALUES(${handoff.id},${handoff.user_id},'processing_grant',${handoff.accepted_at_ms},${handoff.disclosure},${"web:" + handoff.id},${"web:" + handoff.id},${handoff.accepted_at_ms}) RETURNING 1`
  );
  yield* requireWrite(
    yield* sql`INSERT INTO backup_recovery_credentials(user_id,code_digest,created_at_ms,revision) VALUES(${handoff.user_id},${recoveryDigest},${now},1) RETURNING 1`
  );

  return true;
});

const usableInvitation = (handoff: Handoff, now: number): boolean =>
  handoff.invitation === null ||
  (handoff.decision === "confirmed" &&
    handoff.review_attempt === handoff.id &&
    handoff.invitation_expiry !== null &&
    handoff.invitation_expiry > now &&
    [
      handoff.portfolio,
      handoff.bsuid,
      handoff.endpoint,
      handoff.review_text,
      handoff.decision_message,
      handoff.confirmed_ms,
    ].every((value) => value !== null));

const completionResult = (created: boolean, recovery: Recovery): object =>
  created ? { status: "created", backupRecoveryCode: recovery.code } : { status: "approved" };

const approveOwner = Effect.fn(function* (handoff: Handoff, now: number, recovery: Recovery) {
  const sql = yield* SqliteClient;
  const [user] = yield* sql`SELECT id,whatsapp_bsuid FROM users`;
  const create = user === undefined;

  if (create) {
    if (!(yield* establishUser(handoff, now, recovery))) return invalidProvider();
  } else {
    if (handoff.invitation !== null && user.whatsapp_bsuid !== null) return invalidProvider();

    const [owner] =
      yield* sql`SELECT 1 FROM provider_credentials c JOIN users u ON u.id=c.user_id WHERE c.user_id=${handoff.user_id} AND c.issuer=${handoff.issuer} AND c.subject=${handoff.subject} AND u.lifetime_registered=1`;

    if (owner === undefined) return invalidProvider();
  }

  if (handoff.invitation !== null) {
    yield* requireWrite(
      yield* sql`UPDATE users SET whatsapp_portfolio_id=${handoff.portfolio},whatsapp_bsuid=${handoff.bsuid},whatsapp_verified_at_ms=${handoff.confirmed_ms} WHERE id=${handoff.user_id} AND whatsapp_bsuid IS NULL RETURNING 1`
    );
  }

  yield* sql`UPDATE browser_handoffs SET state='invalidated' WHERE ordinal<${handoff.ordinal} AND state='ready'`;
  yield* requireWrite(
    yield* sql`UPDATE browser_handoffs SET outcome='committed',state='ready' WHERE id=${handoff.id} RETURNING 1`
  );

  const completed = completionResult(create, recovery);

  return Response.json(
    handoff.invitation === null ? completed : { ...completed, whatsappReturnUrl: fidyWhatsAppUrl },
    { headers: { "cache-control": "no-store" } }
  );
});

const activate = Effect.fn(function* (handoff: Handoff, digest: string, recovery: Recovery) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  const proof = yield* checkHandoff(handoff, digest, now);

  if (proof === "invalid" || !usableInvitation(handoff, now)) return invalidProvider();

  if (proof === "committed") return accepted();

  const [later] =
    yield* sql`SELECT 1 FROM browser_handoffs WHERE state='ready' AND wrong_attempts<5 AND expires_at_ms>${now} AND ordinal>${handoff.ordinal} LIMIT 1`;

  if (later !== undefined) return invalidProvider();

  return yield* approveOwner(handoff, now, recovery);
});

const reserveAndActivate = Effect.fn(function* (
  handoff: Handoff,
  digest: string,
  env: Environment
) {
  const sql = yield* SqliteClient;

  if (handoff.id === handoff.creation_attempt && handoff.established === 0) {
    yield* registerUserLifetime(env.MAINTENANCE, handoff.user_id);
  }

  const code = sampleRecoveryCode();
  const recoveryDigest = yield* Effect.tryPromise(() => recoveryCodeDigest(code));
  let generation = 0;

  if (handoff.id === handoff.creation_attempt && handoff.established === 0) {
    const [candidate] =
      yield* sql`UPDATE browser_handoffs SET recovery_generation=recovery_generation+1 WHERE id=${handoff.id} AND outcome='pending' RETURNING recovery_generation`;

    if (candidate === undefined) {
      const result = yield* checkHandoff(handoff, digest, yield* Clock.currentTimeMillis);

      return result === "committed" ? accepted() : invalidProvider();
    }

    generation = yield* Schema.decodeUnknownEffect(Schema.Int)(candidate.recovery_generation);

    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      attempt: handoff.id,
      user: handoff.user_id,
      digest: Hex.encode(recoveryDigest),
      generation,
    });

    const registration = yield* Effect.tryPromise((signal) =>
      env.DIRECTORY.getByName(directoryName).fetch(reserveRecoveryUrl, {
        method: "POST",
        body,
        signal,
      })
    );

    if (!registration.ok) return unavailable();
  }

  return yield* activate(handoff, digest, { code, recoveryDigest, generation }).pipe(
    withStoreCapacity("growth")
  );
});

const cancelHandoff = Effect.fn(function* (handoff: Handoff) {
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    yield* importHandoff(handoff);
    yield* sql`UPDATE browser_handoffs SET outcome='cancelled',state='invalidated' WHERE id=${handoff.id} AND outcome<>'committed' RETURNING id`;

    const [record] =
      yield* sql`SELECT outcome FROM browser_handoffs WHERE id=${handoff.id} AND user_id=${handoff.user_id}`;

    const outcome = yield* Schema.decodeUnknownEffect(Schema.Literals(["cancelled", "committed"]))(
      record?.outcome
    );

    return Response.json({ outcome });
  }).pipe(withStoreCapacity("required"));
});

const completeVerified = Effect.fn(function* (
  input: unknown,
  handoff: Handoff,
  { request, env }: Readonly<{ request: Request; env: Environment }>
) {
  const parsed = Schema.decodeUnknownOption(ImportProof)(input);

  if (Option.isNone(parsed)) return invalidProvider();

  if (
    handoff.invitation !== null &&
    request.url === bootstrapCompleteUrl &&
    parsed.value.associationCode !== handoff.review_code
  ) {
    return invalidProvider();
  }

  const digest = yield* digestVerifier(parsed.value.privateVerifier);

  const proofState = yield* Effect.gen(function* () {
    const sql = yield* SqliteClient;

    if (
      (yield* sql`SELECT 1 FROM erasure_requests WHERE user_id=${handoff.user_id}`).length !== 0
    ) {
      return "invalid" as const;
    }

    yield* importHandoff(handoff);

    return yield* checkHandoff(handoff, digest, yield* Clock.currentTimeMillis);
  }).pipe(withStoreCapacity("required"));

  if (proofState === "invalid") return invalidProvider();

  if (request.url !== bootstrapCompleteUrl) {
    return Response.json({ status: "verified" }, { headers: { "cache-control": "no-store" } });
  }

  if (proofState === "committed") return accepted();

  return yield* reserveAndActivate(handoff, digest, env);
});

const failedLookup = (status: number): Response =>
  status === missingStatus ? invalidProvider() : unavailable();

export const completeLocalBootstrap = Effect.fn(function* (
  request: Request,
  env: Environment,
  owns: (user: string) => boolean
) {
  const cancel = request.url === bootstrapCancelUrl;

  const proof = yield* boundedJsonBody({
    request,
    policy: proofPolicy,
    schema: cancel
      ? Schema.Struct({ pairingId: BrowserLoginPairingId, id: Schema.String })
      : ImportProof,
  });

  if (Option.isNone(proof)) return invalidProvider();
  const input = proof.value;

  const lookup = yield* Effect.tryPromise((signal) =>
    env.DIRECTORY.getByName(directoryName).fetch(handoffInspectUrl, {
      method: "POST",
      body: input.id,
      signal,
    })
  );

  if (!lookup.ok) return failedLookup(lookup.status);

  const handoff = yield* Schema.decodeUnknownEffect(FrozenBrowserHandoff)(
    yield* Effect.tryPromise(() => lookup.json())
  );

  if (!owns(handoff.user_id) || handoff.pairing_id !== input.pairingId) return invalidProvider();

  if (cancel) return yield* cancelHandoff(handoff);

  return yield* completeVerified(input, handoff, { request, env });
});
