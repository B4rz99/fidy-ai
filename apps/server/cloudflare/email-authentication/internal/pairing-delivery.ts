import { EmailAddress, EmailVerificationCode } from "@fidy/server/client";

import type { WorkflowStepConfig } from "cloudflare:workers";

import { Clock, Effect, Option, Schema } from "effect";

import type { BrowserPairingEmailEnvironment } from "../runtime";

import { internals as onboardingDelivery } from "./onboarding-delivery";

const { deliveryState, sendThroughResend } = onboardingDelivery;

const Work = Schema.Struct({
  kind: Schema.Literal("browser-pairing-email"),
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID()),
});

const Outbox = Schema.Struct({ id: Schema.String.check(Schema.isUUID()) });

const Pending = Schema.Struct({
  email_address: EmailAddress,
  expires_at_ms: Schema.Finite,
  state: Schema.Literals([
    "awaiting_delivery",
    "sending",
    "awaiting_proof",
    "rejected",
    "ambiguous",
    "approved",
  ]),
});

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const dispatchCooldownMilliseconds = 60000;

const proofLifetimeMilliseconds = 600000;

const publicSymbols = 8;

const secretSymbols = 16;

const symbols = (length: number): string =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(length)),
    (byte) => alphabet[byte % alphabet.length]
  ).join("");

const group = (code: string): string => code.match(/.{4}/gu)?.join("-") ?? "";

const digest = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });

export type DispatchEnvironment = {
  DB: D1Database;
  BROWSER_PAIRING_EMAIL_QUEUE: {
    send: (work: typeof Work.Type) => Promise<unknown>;
  };
};

const publishWork = (
  environment: DispatchEnvironment,
  id: string,
  current: number
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const claim = yield* attempt(() =>
      environment.DB.prepare(`UPDATE browser_pairing_email_outbox
    SET last_attempt_at_ms = ? WHERE id = ? AND
    (last_attempt_at_ms IS NULL OR last_attempt_at_ms < ?)`)
        .bind(current, id, current - dispatchCooldownMilliseconds)
        .run()
    );
    if (claim.meta.changes !== 1) return;
    yield* attempt(() =>
      environment.BROWSER_PAIRING_EMAIL_QUEUE.send({
        kind: "browser-pairing-email",
        version: 1,
        id,
      })
    );
    yield* attempt(() =>
      environment.DB.prepare(`UPDATE browser_pairing_email_outbox
    SET published_at_ms = ? WHERE id = ?`)
        .bind(current, id)
        .run()
    );
  });

export type Send = (
  to: EmailAddress,
  code: EmailVerificationCode,
  id: string
) => Promise<"succeeded" | "rejected" | "ambiguous">;

/** Claim one generation before any provider call, never retrying an ambiguous send with a new code. */
const deliverBrowserPairingEmail =
  ({ db, send }: { db: D1Database; send: Send }) =>
  (id: string): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const observedAt = yield* Clock.currentTimeMillis;
        const raw = yield* attempt(() =>
          db
            .prepare(`SELECT e.email_address, e.expires_at_ms, e.state
      FROM browser_pairing_email_proofs AS e JOIN browser_login_pairings AS p ON p.id = e.pairing_id
      JOIN verified_email_credentials AS v ON v.user_id = e.user_id
        AND v.email_address = e.email_address AND v.verified_at_ms = e.credential_verified_at_ms
      WHERE e.work_id = ? AND p.state = 'pending_approval' AND p.expires_at_ms > ?`)
            .bind(id, observedAt)
            .first()
        );
        const pending = Schema.decodeUnknownOption(Pending)(raw);
        if (Option.isNone(pending) || pending.value.state !== "awaiting_delivery") return;
        const publicCode = group(symbols(publicSymbols));
        const secret = group(symbols(secretSymbols));
        const combinedCode = yield* Schema.decodeEffect(EmailVerificationCode)(
          `${publicCode}-${secret}`
        ).pipe(Effect.orDie);
        const current = yield* Clock.currentTimeMillis;
        const proofDigest = yield* attempt(() => digest(secret));
        const claimed = yield* attempt(() =>
          db
            .prepare(`UPDATE browser_pairing_email_proofs
      SET state = 'sending', public_code = ?, proof_digest = ?, proof_expires_at_ms = ?
      WHERE work_id = ? AND state = 'awaiting_delivery' AND expires_at_ms > ?
        AND EXISTS (SELECT 1 FROM browser_login_pairings AS p
          WHERE p.id = pairing_id AND p.state = 'pending_approval' AND p.expires_at_ms > ?)`)
            .bind(
              publicCode,
              proofDigest,
              Math.min(current + proofLifetimeMilliseconds, pending.value.expires_at_ms),
              id,
              current,
              current
            )
            .run()
        );
        if (claimed.meta.changes !== 1) return;
        const outcome = yield* attempt(() => send(pending.value.email_address, combinedCode, id));
        const nextState = outcome === "succeeded" ? "awaiting_proof" : outcome;
        const retainProof = nextState === "awaiting_proof" ? nextState : "ambiguous";
        yield* attempt(() =>
          db
            .prepare(`UPDATE browser_pairing_email_proofs SET state = ?,
      public_code = CASE WHEN ? = 'awaiting_proof' THEN public_code ELSE NULL END,
      proof_digest = CASE WHEN ? = 'awaiting_proof' THEN proof_digest ELSE NULL END,
      proof_expires_at_ms = CASE WHEN ? = 'awaiting_proof' THEN proof_expires_at_ms ELSE NULL END
      WHERE work_id = ? AND state = 'sending'`)
            .bind(nextState, retainProof, retainProof, retainProof, id)
            .run()
        );
      })
    );

const sendPairingProof =
  (environment: Pick<BrowserPairingEmailEnvironment, "RESEND_API_KEY">): Send =>
  (to, code, id) =>
    sendThroughResend({
      purpose: "browser-pairing-approval",
      environment,
      to,
      combinedCode: code,
      id,
    }).then((result) => {
      const outcome = deliveryState(result);
      return outcome === "awaiting_proof" ? "succeeded" : outcome;
    });

export type DeliveryActivity = (
  name: string,
  options: WorkflowStepConfig,
  run: () => Promise<void>
) => Promise<void>;

export const internals = {
  Work,
  Outbox,
  Pending,
  alphabet,
  dispatchCooldownMilliseconds,
  proofLifetimeMilliseconds,
  publicSymbols,
  secretSymbols,
  symbols,
  group,
  digest,
  attempt,
  publishWork,
  deliverBrowserPairingEmail,
  sendPairingProof,
};
