import { EmailAddress, EmailVerificationCode } from "@fidy/server/client";

import { Clock, Effect, Option, Schema } from "effect";

const Work = Schema.Struct({
  kind: Schema.Literal("email-replacement"),
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID()),
});

const Pending = Schema.Struct({
  candidate_email: EmailAddress,
  expires_at_ms: Schema.Finite,
  state: Schema.Literals([
    "awaiting_delivery",
    "sending",
    "awaiting_proof",
    "rejected",
    "ambiguous",
  ]),
});

const Outbox = Schema.Struct({ id: Schema.String.check(Schema.isUUID()) });

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

const group = (value: string): string => value.match(/.{4}/gu)?.join("-") ?? "";

const digest = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });

const findDeliverable = (
  db: D1Database,
  id: string,
  current: number
): Promise<Option.Option<typeof Pending.Type>> =>
  Effect.runPromise(
    Effect.map(
      attempt(() =>
        db
          .prepare(`SELECT r.candidate_email, r.expires_at_ms, r.state
    FROM email_replacements AS r JOIN verified_email_credentials AS v ON v.user_id = r.user_id
      AND v.email_address = r.prior_email AND v.verified_at_ms = r.prior_verified_at_ms
    JOIN web_sessions AS s ON s.id = r.session_id AND s.user_id = r.user_id
    WHERE r.work_id = ? AND s.revoked_at_ms IS NULL AND s.fresh_until_ms > ?
      AND s.idle_expires_at_ms > ? AND s.hard_expires_at_ms > ?`)
          .bind(id, current, current, current)
          .first()
      ),
      Schema.decodeUnknownOption(Pending)
    )
  );

export /** Claim one candidate generation before the provider call; an ambiguous send never retries its proof. */
type Send = (
  to: EmailAddress,
  code: EmailVerificationCode,
  id: string
) => Promise<"succeeded" | "rejected" | "ambiguous">;

const deliverEmailReplacement =
  ({ db, send }: { db: D1Database; send: Send }) =>
  (id: string): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;
        const pending = yield* attempt(() => findDeliverable(db, id, current));
        if (
          Option.isNone(pending) ||
          pending.value.state !== "awaiting_delivery" ||
          pending.value.expires_at_ms <= current
        ) {
          return;
        }
        const publicCode = group(symbols(publicSymbols));
        const secret = group(symbols(secretSymbols));
        const code = yield* Schema.decodeEffect(EmailVerificationCode)(
          `${publicCode}-${secret}`
        ).pipe(Effect.orDie);
        const proofDigest = yield* attempt(() => digest(secret));
        const claimed = yield* attempt(() =>
          db
            .prepare(`UPDATE email_replacements SET state = 'sending', public_code = ?,
      proof_digest = ?, proof_expires_at_ms = ? WHERE work_id = ? AND state = 'awaiting_delivery'
        AND expires_at_ms > ? AND EXISTS (SELECT 1 FROM verified_email_credentials AS v
          WHERE v.user_id = email_replacements.user_id AND v.email_address = prior_email
            AND v.verified_at_ms = prior_verified_at_ms)
        AND EXISTS (SELECT 1 FROM web_sessions AS s WHERE s.id = session_id
          AND s.user_id = email_replacements.user_id AND s.revoked_at_ms IS NULL
          AND s.fresh_until_ms > ? AND s.idle_expires_at_ms > ? AND s.hard_expires_at_ms > ?)`)
            .bind(
              publicCode,
              proofDigest,
              Math.min(current + proofLifetimeMilliseconds, pending.value.expires_at_ms),
              id,
              current,
              current,
              current,
              current
            )
            .run()
        );
        if (claimed.meta.changes !== 1) return;
        const outcome = yield* attempt(() => send(pending.value.candidate_email, code, id));
        const state = outcome === "succeeded" ? "awaiting_proof" : outcome;
        yield* attempt(() =>
          db
            .prepare(`UPDATE email_replacements SET state = ?,
      public_code = CASE WHEN ? = 'awaiting_proof' THEN public_code ELSE NULL END,
      proof_digest = CASE WHEN ? = 'awaiting_proof' THEN proof_digest ELSE NULL END,
      proof_expires_at_ms = CASE WHEN ? = 'awaiting_proof' THEN proof_expires_at_ms ELSE NULL END
      WHERE work_id = ? AND state = 'sending'`)
            .bind(state, state, state, state, id)
            .run()
        );
      })
    );

export const internals = {
  Work,
  Pending,
  Outbox,
  alphabet,
  dispatchCooldownMilliseconds,
  proofLifetimeMilliseconds,
  publicSymbols,
  secretSymbols,
  symbols,
  group,
  digest,
  attempt,
  findDeliverable,
  deliverEmailReplacement,
};
