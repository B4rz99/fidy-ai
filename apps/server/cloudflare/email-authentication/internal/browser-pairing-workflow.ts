import {
  captureWorkTrace,
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  sanitizeWorkTrace,
  workTraceParent,
  workerRelease,
} from "../../runtime/telemetry/operations";
import { type BrowserPairingEmailEnvironment, BrowserPairingEmailWork as Work } from "../contract";

import { pendingBrowserPairingQuery } from "../../browser-login/operations";

import {
  EmailAddress,
  EmailVerificationCode,
} from "../../../src/core/email-authentication/contract";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { Clock, Effect, Exit, Option, Schema } from "effect";
import { deliveryState, sendThroughResend } from "./proof-delivery";

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
  BROWSER_PAIRING_EMAIL_QUEUE: { send: (work: Work) => Promise<unknown> };
};

const publishWork = (
  environment: DispatchEnvironment,
  id: string,
  current: number
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const trace = yield* captureWorkTrace;
    const claim = yield* attempt(() =>
      environment.DB.prepare(`UPDATE browser_login_pairings AS browser_pairing_email_proofs SET email_dispatch_attempted_at_ms = ? WHERE email_work_id IS NOT NULL AND email_work_id = ? AND
    (email_dispatch_attempted_at_ms IS NULL OR email_dispatch_attempted_at_ms < ?)`)
        .bind(current, id, current - dispatchCooldownMilliseconds)
        .run()
    );
    if (claim.meta.changes !== 1) return;
    yield* attempt(() =>
      environment.BROWSER_PAIRING_EMAIL_QUEUE.send({
        ...trace,
        kind: "browser-pairing-email",
        version: 1,
        id,
      })
    );
  });

/** Offer at most 32 unexpired, secret-free email-work identities per scheduled tick. */
export const dispatchBrowserPairingEmail = (
  environment: DispatchEnvironment & { readonly identity: Option.Option<string> }
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const identity = environment.identity;
    const current = yield* Clock.currentTimeMillis;
    const pairing = pendingBrowserPairingQuery({
      subject: { sql: "SELECT e.pairing_id AS pairingId", params: [] },
      current,
    });
    const rows = yield* attempt(() =>
      environment.DB.prepare(`SELECT e.work_id AS id
    FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS e
    WHERE e.state = 'awaiting_delivery' AND e.expires_at_ms > ?
      AND EXISTS (${pairing.sql})
      AND (e.dispatch_attempted_at_ms IS NULL OR e.dispatch_attempted_at_ms < ?)
      AND (? IS NULL OR e.work_id = ?)
    ORDER BY e.last_requested_at_ms LIMIT 32`)
        .bind(
          current,
          ...pairing.params,
          current - dispatchCooldownMilliseconds,
          Option.getOrNull(identity),
          Option.getOrNull(identity)
        )
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
  Option.isSome(Schema.decodeUnknownOption(Schema.Struct({ kind: Work.fields.kind }))(value));

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
          environment.DB.prepare(`SELECT email_address, email_expires_at_ms AS expires_at_ms, email_state AS state
        FROM browser_login_pairings WHERE email_work_id = ?`)
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
        const params = yield* sanitizeWorkTrace(decoded.value);
        const started = yield* Effect.exit(
          attempt(() =>
            environment.BROWSER_PAIRING_EMAIL_WORKFLOW.create({
              id: decoded.value.id,
              params,
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
  coordinates: Readonly<{ id: string; parent: unknown }>
) => Promise<"succeeded" | "rejected" | "ambiguous">;

const findPendingProof = (
  db: D1Database,
  id: string
): Effect.Effect<Option.Option<typeof Pending.Type>, void> =>
  Effect.gen(function* () {
    const observedAt = yield* Clock.currentTimeMillis;
    const pairing = pendingBrowserPairingQuery({
      subject: { sql: "SELECT e.pairing_id AS pairingId", params: [] },
      current: observedAt,
    });
    const raw = yield* attempt(() =>
      db
        .prepare(`SELECT e.email_address, e.expires_at_ms, e.state
      FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS e
      JOIN verified_email_credentials AS v ON v.user_id = e.user_id
        AND v.address = e.email_address AND v.verified_at_ms = e.credential_verified_at_ms
      WHERE e.work_id = ? AND EXISTS (${pairing.sql})`)
        .bind(id, ...pairing.params)
        .first()
    );
    return Schema.decodeUnknownOption(Pending)(raw);
  });

const settlePairingDelivery = (
  db: D1Database,
  id: string,
  nextState: string
): Effect.Effect<unknown, void> => {
  const retainProof = nextState === "awaiting_proof" ? nextState : "ambiguous";
  return attempt(() =>
    db
      .prepare(`UPDATE browser_login_pairings AS browser_pairing_email_proofs SET email_state = ?,
      email_public_code = CASE WHEN ? = 'awaiting_proof' THEN email_public_code ELSE NULL END,
      email_proof_digest = CASE WHEN ? = 'awaiting_proof' THEN email_proof_digest ELSE NULL END,
      email_proof_expires_at_ms = CASE WHEN ? = 'awaiting_proof' THEN email_proof_expires_at_ms ELSE NULL END
      WHERE email_work_id IS NOT NULL AND email_work_id = ? AND email_state = 'sending'`)
      .bind(nextState, retainProof, retainProof, retainProof, id)
      .run()
  );
};

/** Claim one generation before any provider call, never retrying an ambiguous send with a new code. */
export const deliverBrowserPairingEmail =
  ({ db, send, environment }: { db: D1Database; send: Send; environment: unknown }) =>
  (id: string, parent?: unknown): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const pending = yield* findPendingProof(db, id);
        if (Option.isNone(pending) || pending.value.state !== "awaiting_delivery") return;
        const publicCode = group(symbols(publicSymbols));
        const secret = group(symbols(secretSymbols));
        const combinedCode = yield* Schema.decodeEffect(EmailVerificationCode)(
          `${publicCode}-${secret}`
        ).pipe(Effect.orDie);
        const current = yield* Clock.currentTimeMillis;
        const proofDigest = yield* attempt(() => digest(secret));
        const pairing = pendingBrowserPairingQuery({
          subject: {
            sql: "SELECT browser_pairing_email_proofs.id AS pairingId",
            params: [],
          },
          current,
        });
        const claimed = yield* attempt(() =>
          db
            .prepare(`UPDATE browser_login_pairings AS browser_pairing_email_proofs SET email_state = 'sending', email_public_code = ?, email_proof_digest = ?, email_proof_expires_at_ms = ?
      WHERE email_work_id IS NOT NULL AND email_work_id = ? AND email_state = 'awaiting_delivery' AND email_expires_at_ms > ?
        AND EXISTS (${pairing.sql})`)
            .bind(
              publicCode,
              proofDigest,
              Math.min(current + proofLifetimeMilliseconds, pending.value.expires_at_ms),
              id,
              current,
              ...pairing.params
            )
            .run()
        );
        if (claimed.meta.changes !== 1) return;
        const trace = yield* captureWorkTrace;
        const outcome = yield* attempt(() =>
          send(pending.value.email_address, combinedCode, { id, parent: workTraceParent(trace) })
        );
        const nextState = outcome === "succeeded" ? "awaiting_proof" : outcome;
        yield* settlePairingDelivery(db, id, nextState);
      }).pipe(
        observeWorkerExecution({
          environment: workerRelease(environment),
          telemetry: cloudflareWorkerTelemetry,
          operation: "workflow.browserPairingEmail",
          parent,
        })
      )
    );

const sendPairingProof =
  (environment: Pick<BrowserPairingEmailEnvironment, "RESEND_API_KEY">): Send =>
  (to, code, { id, parent }) =>
    sendThroughResend({
      parent,
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

/** Validate the Queue payload again at the Workflow boundary before accessing D1. */
export const runBrowserPairingEmailWorkflow = ({
  environment,
  payload,
  activity,
}: {
  environment: Pick<BrowserPairingEmailEnvironment, "DB" | "RESEND_API_KEY">;
  payload: unknown;
  activity: DeliveryActivity;
}): Promise<void> => {
  const work = Schema.decodeUnknownOption(Work)(payload);
  if (Option.isNone(work)) return Promise.resolve();
  return activity(
    "send-browser-pairing-email-v1",
    { retries: { limit: 0, delay: "1 second" } },
    () =>
      deliverBrowserPairingEmail({
        db: environment.DB,
        send: sendPairingProof(environment),
        environment,
      })(work.value.id, workTraceParent(work.value))
  );
};

/** Abandon interrupted claimed sends without ever reusing their unobservable raw proof. */
export const reconcileBrowserPairingEmail = (db: D1Database): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    yield* attempt(() =>
      db
        .prepare(`UPDATE browser_login_pairings AS browser_pairing_email_proofs SET email_state = 'ambiguous', email_public_code = NULL, email_proof_digest = NULL, email_proof_expires_at_ms = NULL
      WHERE email_work_id IS NOT NULL AND email_state = 'sending' AND email_proof_expires_at_ms < ?`)
        .bind(current - proofLifetimeMilliseconds)
        .run()
    );
    yield* attempt(() =>
      db
        .prepare(`UPDATE browser_login_pairings AS browser_pairing_email_proofs SET email_work_id=NULL,email_user_id=NULL,email_address=NULL,email_credential_verified_at_ms=NULL,email_state=NULL,email_public_code=NULL,email_proof_digest=NULL,email_proof_expires_at_ms=NULL,email_expires_at_ms=NULL,email_generation=NULL,email_wrong_attempts=NULL,email_last_requested_at_ms=NULL,email_dispatch_attempted_at_ms=NULL WHERE email_work_id IS NOT NULL AND id IN
      (SELECT id FROM browser_login_pairings WHERE email_work_id IS NOT NULL AND email_expires_at_ms <= ? LIMIT 32)`)
        .bind(current)
        .run()
    );
  });
