import { EmailReplacementMutation } from "@fidy/server/email-authentication-operations";

import type { PreparedOnboardingCredential } from "./contract";

import {
  OnboardingProofRow,
  onboardingDigestMatches,
  onboardingProofDigest,
  preparedOnboardingCredential,
  recordWrongOnboardingProof,
} from "./internal/onboarding";

import {
  CompleteEmailReplacementPayload,
  EmailVerificationCode,
  RequestEmailReplacementPayload,
} from "@fidy/server/client";

import { canRedeemOnboardingProof } from "@fidy/server/email-authentication-policy";

import {
  browserReplacementCaller,
  emailReplacementImplementations,
  permitsFreshBrowserReplacement,
} from "@fidy/server/email-authentication-runtime";

import { Clock, Data, Effect, Option, Schema } from "effect";

import { freshBrowserSession } from "../web-session/operations";

import { internals as replacementInternals } from "./internal/replacement";

import { internals as pairingInternals } from "./internal/pairing";

/** D1 could not establish proof authority. No storage detail or submitted material escapes. */
export class OnboardingProofUnavailable extends Data.TaggedError(
  "OnboardingProofUnavailable"
)<{}> {}

/** The proof attempt could not complete; preserve the same non-enumerating refusal as invalid proof. */
export class OnboardingProofRejected extends Data.TaggedError("OnboardingProofRejected")<{}> {}

/**
 * Validate a bounded mailbox proof without creating a User. Wrong proofs charge the enrollment's
 * fixed failure budget; missing, expired and exhausted proofs share absence. Success exposes only
 * composition references and the two Email Authentication statements for one atomic onboarding unit.
 */
export const prepareOnboardingCredential = (
  input: Readonly<{
    db: D1Database;
    combinedCode: unknown;
    nowMs: number;
  }>
): Effect.Effect<
  Option.Option<PreparedOnboardingCredential>,
  OnboardingProofUnavailable | OnboardingProofRejected
> =>
  Effect.gen(function* () {
    const code = Schema.decodeUnknownOption(EmailVerificationCode)(input.combinedCode);
    if (Option.isNone(code)) return Option.none();
    const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, OnboardingProofRejected> =>
      Effect.tryPromise({ try: run, catch: () => new OnboardingProofRejected() });
    const raw = yield* attempt(() =>
      input.db
        .prepare(`SELECT id, exchange_id, email_address, proof_digest,
      expires_at_ms, proof_expires_at_ms, state FROM pending_email_enrollments WHERE public_code = ?`)
        .bind(code.value.slice(0, onboardingPublicCodeLength))
        .first()
    );
    if (raw === null) return Option.none();
    const decoded = Schema.decodeUnknownOption(OnboardingProofRow)(raw);
    if (Option.isNone(decoded)) return yield* new OnboardingProofUnavailable();
    const row = decoded.value;
    if (
      !canRedeemOnboardingProof({
        state: row.state,
        expiresAtMs: row.expires_at_ms,
        proofExpiresAtMs: row.proof_expires_at_ms,
        nowMs: input.nowMs,
      })
    ) {
      return Option.none();
    }
    const candidate = yield* attempt(() =>
      onboardingProofDigest(code.value.slice(onboardingProofOffset))
    );
    if (!onboardingDigestMatches({ stored: row.proof_digest, candidate })) {
      yield* attempt(() => recordWrongOnboardingProof({ db: input.db, enrollmentId: row.id }));
      return Option.none();
    }
    return Option.some(preparedOnboardingCredential({ db: input.db, row }));
  });

const {
  HTTP_OK: replacementHTTP_OK,
  attempt: replacementattempt,
  fresh: replacementfresh,
  invalid: replacementinvalid,
  json: replacementjson,
  readProof: replacementreadProof,
  recordMalformedInput: replacementrecordMalformedInput,
  replacementAdapter: replacementreplacementAdapter,
  unavailable: replacementunavailable,
} = replacementInternals;

/** Start a candidate-mailbox proof for a fresh WebSession, without disclosing collisions. */
export const requestEmailReplacement = ({
  request,
  db,
  onAccepted,
}: {
  request: globalThis.Request;
  db: D1Database;
  onAccepted: (id: string) => void;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* replacementattempt(() =>
        replacementreadProof(request, RequestEmailReplacementPayload)
      );
      if (Option.isNone(input)) return replacementinvalid();
      {
        const current = yield* Clock.currentTimeMillis;
        const session = yield* replacementattempt(() =>
          freshBrowserSession({ request, db, current })
        );
        if (Option.isNone(session)) return replacementfresh();
        if (!permitsFreshBrowserReplacement("request")) return replacementunavailable();
        const result = yield* emailReplacementImplementations
          .request({ payload: input.value }, browserReplacementCaller(session.value))
          .pipe(
            Effect.provideService(
              EmailReplacementMutation,
              replacementreplacementAdapter({ db, session: session.value, current, onAccepted })
            )
          );
        return replacementjson(result, replacementHTTP_OK);
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(replacementunavailable())))
  );

/** Consume a candidate-mailbox proof only while the initiating User still has fresh browser authority. */
export const completeEmailReplacement = ({
  request,
  db,
}: {
  request: globalThis.Request;
  db: D1Database;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* replacementattempt(() =>
        replacementreadProof(request, CompleteEmailReplacementPayload)
      );
      if (Option.isNone(input)) {
        // No successful credential transition can follow malformed input, even if audit fails.
        yield* Effect.exit(replacementrecordMalformedInput(request, db));
        return replacementinvalid();
      }
      {
        const current = yield* Clock.currentTimeMillis;
        const session = yield* replacementattempt(() =>
          freshBrowserSession({ request, db, current })
        );
        if (Option.isNone(session)) return replacementfresh();
        if (!permitsFreshBrowserReplacement("complete")) return replacementunavailable();
        return yield* emailReplacementImplementations
          .complete({ payload: input.value }, browserReplacementCaller(session.value))
          .pipe(
            Effect.provideService(
              EmailReplacementMutation,
              replacementreplacementAdapter({
                db,
                session: session.value,
                current,
                onAccepted: () => undefined,
              })
            ),
            Effect.match({
              onSuccess: (result) => replacementjson(result, replacementHTTP_OK),
              onFailure: replacementinvalid,
            })
          );
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(replacementinvalid())))
  );

const {
  Complete: pairingComplete,
  EmailProofRow: pairingEmailProofRow,
  Start: pairingStart,
  approveEmailPairing: pairingapproveEmailPairing,
  attempt: pairingattempt,
  checkPairing: pairingcheckPairing,
  digest: pairingdigest,
  emailCooldownMilliseconds: pairingemailCooldownMilliseconds,
  equalDigest: pairingequalDigest,
  invalid: pairinginvalid,
  newId: pairingnewId,
  pending: pairingpending,
  publicCodeLength: pairingpublicCodeLength,
  readProof: pairingreadProof,
  rejectWrongEmailProof: pairingrejectWrongEmailProof,
  secretOffset: pairingsecretOffset,
  unavailable: pairingunavailable,
} = pairingInternals;

/** Start one bounded email proof only after the browser proves ownership of a pending pairing. */
export const startBrowserPairingEmail = (input: {
  request: Request;
  db: D1Database;
  onAccepted: (id: string) => void;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { request, db } = input;
      const proof = yield* pairingattempt(() => pairingreadProof(request, pairingStart));
      if (Option.isNone(proof)) return pairinginvalid();
      const expiresAt = yield* pairingattempt(() =>
        pairingcheckPairing(db, proof.value.pairingId, proof.value.privateVerifier)
      );
      if (Option.isNone(expiresAt)) return pairinginvalid();
      const current = yield* Clock.currentTimeMillis;
      const workId = pairingnewId();
      // The proof generation and outbox identity commit together; an unknown mailbox has no effect.
      yield* pairingattempt(() =>
        db.batch([
          db
            .prepare(`INSERT INTO browser_pairing_email_proofs
        (pairing_id, work_id, user_id, email_address, credential_verified_at_ms,
         state, expires_at_ms, generation, last_requested_at_ms)
        SELECT p.id, ?, v.user_id, v.email_address, v.verified_at_ms,
          'awaiting_delivery', p.expires_at_ms, 1, ?
        FROM browser_login_pairings AS p JOIN verified_email_credentials AS v ON v.email_address = ?
        WHERE p.id = ? AND p.state = 'pending_approval' AND p.expires_at_ms > ?
          AND p.expires_at_ms = ? AND p.wrong_attempts < 5
        ON CONFLICT(pairing_id) DO UPDATE SET work_id = excluded.work_id,
          email_address = excluded.email_address,
          user_id = excluded.user_id,
          credential_verified_at_ms = excluded.credential_verified_at_ms,
          state = 'awaiting_delivery', generation = generation + 1,
          last_requested_at_ms = excluded.last_requested_at_ms,
          public_code = NULL, proof_digest = NULL, proof_expires_at_ms = NULL,
          wrong_attempts = 0
        WHERE browser_pairing_email_proofs.state NOT IN ('approved', 'sending')
          AND browser_pairing_email_proofs.generation < 5
          AND browser_pairing_email_proofs.last_requested_at_ms <= ?`)
            .bind(
              workId,
              current,
              proof.value.email,
              proof.value.pairingId,
              current,
              expiresAt.value,
              current - pairingemailCooldownMilliseconds
            ),
          db
            .prepare(`INSERT INTO browser_pairing_email_outbox (id, created_at_ms)
        SELECT work_id, ? FROM browser_pairing_email_proofs
        WHERE work_id = ? AND state = 'awaiting_delivery'`)
            .bind(current, workId),
        ])
      );
      input.onAccepted(workId);
      return pairingpending();
    }).pipe(Effect.catchCause(() => Effect.succeed(pairingunavailable())))
  );

/** Consume a mailbox proof and bind only its credential's stable User to the same browser challenge. */
export const completeBrowserPairingEmail = (input: {
  request: Request;
  db: D1Database;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { request, db } = input;
      const proof = yield* pairingattempt(() => pairingreadProof(request, pairingComplete));
      if (Option.isNone(proof)) return pairinginvalid();
      {
        const expiresAt = yield* pairingattempt(() =>
          pairingcheckPairing(db, proof.value.pairingId, proof.value.privateVerifier)
        );
        if (Option.isNone(expiresAt)) return pairinginvalid();
        const current = yield* Clock.currentTimeMillis;
        const publicCode = proof.value.combinedCode.slice(0, pairingpublicCodeLength);
        const raw = yield* pairingattempt(() =>
          db
            .prepare(`SELECT proof_digest, wrong_attempts, work_id
      FROM browser_pairing_email_proofs WHERE pairing_id = ? AND public_code = ?
        AND state = 'awaiting_proof' AND proof_expires_at_ms > ? AND expires_at_ms > ?`)
            .bind(proof.value.pairingId, publicCode, current, current)
            .first()
        );
        if (raw === null) return pairinginvalid();
        const row = Schema.decodeUnknownOption(pairingEmailProofRow)(raw);
        if (Option.isNone(row)) return pairingunavailable();
        if (
          !pairingequalDigest(
            row.value.proof_digest,
            yield* pairingattempt(() =>
              pairingdigest(proof.value.combinedCode.slice(pairingsecretOffset))
            )
          )
        ) {
          yield* pairingattempt(() => pairingrejectWrongEmailProof(db, row.value.work_id));
          return pairinginvalid();
        }
        if (
          !(yield* pairingattempt(() =>
            pairingapproveEmailPairing(db, {
              pairingId: proof.value.pairingId,
              workId: row.value.work_id,
              publicCode,
              current,
            })
          ))
        ) {
          return pairinginvalid();
        }
        return Response.json(
          { status: "pairing_approved" },
          { headers: { "cache-control": "no-store" } }
        );
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(pairingunavailable())))
  );

const onboardingPublicCodeLength = 9;

const onboardingProofOffset = 10;
