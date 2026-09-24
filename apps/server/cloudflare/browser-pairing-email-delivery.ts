import { EmailAddress, EmailVerificationCode } from "@fidy/server/client";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { Clock, Effect, Exit, Function, Option, Schema } from "effect";
import { deliveryState, sendThroughResend } from "./onboarding-email";

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
const dispatchCooldownMilliseconds = 60_000;
const proofLifetimeMilliseconds = 600_000;
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

type DispatchEnvironment = {
  DB: D1Database;
  BROWSER_PAIRING_EMAIL_QUEUE: { send: (work: typeof Work.Type) => Promise<unknown> };
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

/** Offer at most 32 unexpired, secret-free email-work identities per scheduled tick. */
export const dispatchBrowserPairingEmail = (
  environment: DispatchEnvironment
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const rows = yield* attempt(() =>
      environment.DB.prepare(`SELECT o.id
    FROM browser_pairing_email_outbox AS o
    JOIN browser_pairing_email_proofs AS e ON e.work_id = o.id
    JOIN browser_login_pairings AS p ON p.id = e.pairing_id
    WHERE e.state = 'awaiting_delivery' AND e.expires_at_ms > ?
      AND p.state = 'pending_approval' AND p.expires_at_ms > ?
      AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms < ?)
    ORDER BY o.created_at_ms LIMIT 32`)
        .bind(current, current, current - dispatchCooldownMilliseconds)
        .all()
    );
    const outbox = yield* Schema.decodeUnknownEffect(Schema.Array(Outbox))(rows.results).pipe(
      Effect.mapError(() => undefined)
    );
    let failed = false;
    for (const entry of outbox) {
      const published = yield* Effect.exit(publishWork(environment, entry.id, current));
      if (Exit.isFailure(published)) failed = true;
    }
    if (failed) return yield* Effect.fail(undefined);
  });

/** Identify browser-pairing Queue batches without trusting or interpreting their payload as authority. */
export const isBrowserPairingEmailWork = (value: unknown): boolean =>
  Option.isSome(
    Schema.decodeUnknownOption(Schema.Struct({ kind: Schema.Literal("browser-pairing-email") }))(
      value
    )
  );

/** Resolve only bounded work identities; the Activity and Queue never retain raw proof material. */
export const receiveBrowserPairingEmail =
  (environment: { DB: D1Database; BROWSER_PAIRING_EMAIL_WORKFLOW: Workflow }) =>
  (batch: MessageBatch<unknown>): Effect.Effect<void, void> =>
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      for (const message of batch.messages) {
        const decoded = Schema.decodeUnknownOption(Work)(message.body);
        if (Option.isNone(decoded)) {
          message.ack();
          continue;
        }
        const row = yield* attempt(() =>
          environment.DB.prepare(`SELECT email_address, expires_at_ms, state
        FROM browser_pairing_email_proofs WHERE work_id = ?`)
            .bind(decoded.value.id)
            .first()
        );
        if (row === null) {
          message.ack();
          continue;
        }
        const pending = yield* Schema.decodeUnknownEffect(Pending)(row).pipe(
          Effect.mapError(() => undefined)
        );
        if (pending.state !== "awaiting_delivery" || pending.expires_at_ms <= current) {
          message.ack();
          continue;
        }
        const started = yield* Effect.exit(
          attempt(() =>
            environment.BROWSER_PAIRING_EMAIL_WORKFLOW.create({
              id: decoded.value.id,
              params: decoded.value,
            })
          )
        );
        if (Exit.isFailure(started)) {
          yield* attempt(() => environment.BROWSER_PAIRING_EMAIL_WORKFLOW.get(decoded.value.id));
        }
        message.ack();
      }
    });

type Send = (
  to: EmailAddress,
  code: EmailVerificationCode,
  id: string
) => Promise<"succeeded" | "rejected" | "ambiguous">;

/** Claim one generation before any provider call, never retrying an ambiguous send with a new code. */
export const deliverBrowserPairingEmail: {
  (db: D1Database, send: Send): (id: string) => Promise<void>;
  (send: Send): (db: D1Database) => (id: string) => Promise<void>;
} = Function.dual(
  2,
  (db: D1Database, send: Send) =>
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
      )
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

type DeliveryActivity = (
  name: string,
  options: WorkflowStepConfig,
  run: () => Promise<void>
) => Promise<void>;
export type BrowserPairingEmailEnvironment = {
  DB: D1Database;
  BROWSER_PAIRING_EMAIL_QUEUE: Queue;
  BROWSER_PAIRING_EMAIL_WORKFLOW: Workflow;
  RESEND_API_KEY: string;
};

/** Versioned durable delivery; the step result and payload contain no mailbox or proof. */
export class BrowserPairingEmailWorkflowV1 extends WorkflowEntrypoint<
  BrowserPairingEmailEnvironment,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return runBrowserPairingEmailWorkflow(this.env, event.payload, (name, options, activity) =>
      step.do(name, options, activity)
    );
  }
}

/** Validate the Queue payload again at the Workflow boundary before accessing D1. */
export const runBrowserPairingEmailWorkflow: {
  (
    environment: Pick<BrowserPairingEmailEnvironment, "DB" | "RESEND_API_KEY">,
    payload: unknown,
    activity: DeliveryActivity
  ): Promise<void>;
  (
    payload: unknown,
    activity: DeliveryActivity
  ): (environment: Pick<BrowserPairingEmailEnvironment, "DB" | "RESEND_API_KEY">) => Promise<void>;
} = Function.dual(
  3,
  (
    environment: Pick<BrowserPairingEmailEnvironment, "DB" | "RESEND_API_KEY">,
    payload: unknown,
    activity: DeliveryActivity
  ): Promise<void> => {
    const work = Schema.decodeUnknownOption(Work)(payload);
    if (Option.isNone(work)) return Promise.resolve();
    return activity(
      "send-browser-pairing-email-v1",
      { retries: { limit: 0, delay: "1 second" } },
      () => deliverBrowserPairingEmail(environment.DB, sendPairingProof(environment))(work.value.id)
    );
  }
);

/** Abandon interrupted claimed sends without ever reusing their unobservable raw proof. */
export const reconcileBrowserPairingEmail = (db: D1Database): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    yield* attempt(() =>
      db
        .prepare(`UPDATE browser_pairing_email_proofs
      SET state = 'ambiguous', public_code = NULL, proof_digest = NULL, proof_expires_at_ms = NULL
      WHERE state = 'sending' AND proof_expires_at_ms < ?`)
        .bind(current - proofLifetimeMilliseconds)
        .run()
    );
    yield* attempt(() =>
      db
        .prepare(`DELETE FROM browser_pairing_email_outbox WHERE id IN
      (SELECT o.id FROM browser_pairing_email_outbox AS o LEFT JOIN browser_pairing_email_proofs AS p
        ON p.work_id = o.id WHERE p.work_id IS NULL OR p.expires_at_ms <= ?
        OR p.state IN ('approved', 'rejected', 'ambiguous') ORDER BY o.created_at_ms LIMIT 32)`)
        .bind(current)
        .run()
    );
    yield* attempt(() =>
      db
        .prepare(`DELETE FROM browser_pairing_email_proofs WHERE pairing_id IN
      (SELECT pairing_id FROM browser_pairing_email_proofs WHERE expires_at_ms <= ? LIMIT 32)`)
        .bind(current)
        .run()
    );
  });
