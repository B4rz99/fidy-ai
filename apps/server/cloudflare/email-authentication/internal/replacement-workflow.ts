import {
  type EmailReplacementEnvironment,
  type EmailReplacementPublisher,
  type EmailWorkflowInput,
  EmailReplacementWork as Work,
} from "../contract";

import { freshSessionQuery } from "@fidy/server/web-session-operations";
import { EmailAddress, EmailVerificationCode } from "@fidy/server/client";
import { Clock, Effect, Exit, Option, Schema } from "effect";
import { deliveryState, sendThroughResend } from "./onboarding-workflow";

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
const dispatchCooldownMilliseconds = 60_000;
const proofLifetimeMilliseconds = 600_000;
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

/** Publish bounded durable work identities; no mailbox or proof leaves D1 in the Queue. */
export const dispatchEmailReplacement = (
  environment: Readonly<{ DB: D1Database; EMAIL_REPLACEMENT_QUEUE: EmailReplacementPublisher }> & {
    readonly identity: Option.Option<string>;
  }
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const identity = environment.identity;
    const current = yield* Clock.currentTimeMillis;
    const rows = yield* attempt(() =>
      environment.DB.prepare(`SELECT o.id FROM email_replacement_outbox AS o
      JOIN email_replacements AS r ON r.work_id = o.id
      WHERE r.state = 'awaiting_delivery' AND r.expires_at_ms > ?
        AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms < ?)
        AND (? IS NULL OR o.id = ?)
      ORDER BY o.created_at_ms LIMIT 32`)
        .bind(
          current,
          current - dispatchCooldownMilliseconds,
          Option.getOrNull(identity),
          Option.getOrNull(identity)
        )
        .all()
    );
    const entries = yield* Schema.decodeUnknownEffect(Schema.Array(Outbox))(rows.results).pipe(
      Effect.mapError(() => undefined)
    );
    for (const entry of entries) {
      const claimed = yield* attempt(() =>
        environment.DB.prepare(`UPDATE email_replacement_outbox
        SET last_attempt_at_ms = ? WHERE id = ? AND (last_attempt_at_ms IS NULL OR last_attempt_at_ms < ?)`)
          .bind(current, entry.id, current - dispatchCooldownMilliseconds)
          .run()
      );
      if (claimed.meta.changes === 1) {
        yield* attempt(() =>
          environment.EMAIL_REPLACEMENT_QUEUE.send({
            kind: "email-replacement",
            version: 1,
            id: entry.id,
          })
        );
      }
    }
  });

/** Identify the dedicated replacement Queue without interpreting its payload as authority. */
export const isEmailReplacementWork = (value: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(Schema.Struct({ kind: Work.fields.kind }))(value));

/** Recheck D1 state before starting the durable delivery Activity. */
export const receiveEmailReplacement =
  (environment: Pick<EmailReplacementEnvironment, "DB" | "EMAIL_REPLACEMENT_WORKFLOW">) =>
  (batch: MessageBatch<unknown>): Effect.Effect<void, void> =>
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      for (const message of batch.messages) {
        const work = Schema.decodeUnknownOption(Work)(message.body);
        if (Option.isNone(work)) {
          message.ack();
          continue;
        }
        const raw = yield* attempt(() =>
          environment.DB.prepare(`SELECT candidate_email, expires_at_ms, state
        FROM email_replacements WHERE work_id = ?`)
            .bind(work.value.id)
            .first()
        );
        const pending = Schema.decodeUnknownOption(Pending)(raw);
        if (
          Option.isNone(pending) ||
          pending.value.state !== "awaiting_delivery" ||
          pending.value.expires_at_ms <= current
        ) {
          message.ack();
          continue;
        }
        const started = yield* Effect.exit(
          attempt(() =>
            environment.EMAIL_REPLACEMENT_WORKFLOW.create({ id: work.value.id, params: work.value })
          )
        );
        if (Exit.isFailure(started)) {
          yield* attempt(() => environment.EMAIL_REPLACEMENT_WORKFLOW.get(work.value.id));
        }
        message.ack();
      }
    });

const findDeliverable = (
  db: D1Database,
  id: string,
  current: number
): Promise<Option.Option<typeof Pending.Type>> => {
  const session = freshSessionQuery({
    subject: { sql: "SELECT r.session_id AS sessionId, r.user_id AS userId", params: [] },
    current,
  });
  return Effect.runPromise(
    Effect.map(
      attempt(() =>
        db
          .prepare(`SELECT r.candidate_email, r.expires_at_ms, r.state
    FROM email_replacements AS r JOIN verified_email_credentials AS v ON v.user_id = r.user_id
      AND v.email_address = r.prior_email AND v.verified_at_ms = r.prior_verified_at_ms
    WHERE r.work_id = ? AND EXISTS (${session.sql})`)
          .bind(id, ...session.params)
          .first()
      ),
      Schema.decodeUnknownOption(Pending)
    )
  );
};

type Send = (
  to: EmailAddress,
  code: EmailVerificationCode,
  id: string
) => Promise<"succeeded" | "rejected" | "ambiguous">;
/** Claim one candidate generation before the provider call; an ambiguous send never retries its proof. */
export const deliverEmailReplacement =
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
        const session = freshSessionQuery({
          subject: {
            sql: "SELECT email_replacements.session_id AS sessionId, email_replacements.user_id AS userId",
            params: [],
          },
          current,
        });
        const claimed = yield* attempt(() =>
          db
            .prepare(`UPDATE email_replacements SET state = 'sending', public_code = ?,
      proof_digest = ?, proof_expires_at_ms = ? WHERE work_id = ? AND state = 'awaiting_delivery'
        AND expires_at_ms > ? AND EXISTS (SELECT 1 FROM verified_email_credentials AS v
          WHERE v.user_id = email_replacements.user_id AND v.email_address = prior_email
            AND v.verified_at_ms = prior_verified_at_ms)
        AND EXISTS (${session.sql})`)
            .bind(
              publicCode,
              proofDigest,
              Math.min(current + proofLifetimeMilliseconds, pending.value.expires_at_ms),
              id,
              current,
              ...session.params
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

/** Validate versioned identity-only work before entering the non-retrying provider Activity. */
export const runEmailReplacementWorkflow = ({
  environment,
  payload,
  activity,
}: EmailWorkflowInput): Promise<void> => {
  const work = Schema.decodeUnknownOption(Work)(payload);
  if (Option.isNone(work)) return Promise.resolve();
  return activity("send-email-replacement-v1", { retries: { limit: 0, delay: "1 second" } }, () =>
    Effect.tryPromise({
      try: () =>
        deliverEmailReplacement({
          db: environment.DB,
          send: (to, code, id) =>
            sendThroughResend({
              purpose: "credential-replacement",
              environment,
              to,
              combinedCode: code,
              id,
            }).then((result) => {
              const outcome = deliveryState(result);
              return outcome === "awaiting_proof" ? "succeeded" : outcome;
            }),
        })(work.value.id),
      catch: () => undefined,
    }).pipe(Effect.withSpan("emailReplacement.deliver"), Effect.runPromise)
  );
};

/** Bound retention and abandon interrupted sends without reusing unobservable raw proofs. */
export const reconcileEmailReplacement = (db: D1Database): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    yield* attempt(() =>
      db
        .prepare(`UPDATE email_replacements SET state = 'ambiguous', public_code = NULL,
    proof_digest = NULL, proof_expires_at_ms = NULL WHERE state = 'sending' AND proof_expires_at_ms < ?`)
        .bind(current - proofLifetimeMilliseconds)
        .run()
    );
    yield* attempt(() =>
      db
        .prepare(`DELETE FROM email_replacement_outbox WHERE id IN
    (SELECT o.id FROM email_replacement_outbox AS o LEFT JOIN email_replacements AS r ON r.work_id = o.id
      WHERE r.work_id IS NULL OR r.expires_at_ms <= ? OR r.state IN ('rejected', 'ambiguous') LIMIT 32)`)
        .bind(current)
        .run()
    );
    yield* attempt(() =>
      db
        .prepare(`DELETE FROM email_replacements WHERE user_id IN
    (SELECT user_id FROM email_replacements WHERE expires_at_ms <= ? LIMIT 32)`)
        .bind(current)
        .run()
    );
  });
