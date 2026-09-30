import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { Clock, Effect, Exit, Option, Schema } from "effect";

import { captureWorkflowFailure } from "../runtime/operational-workflow-failure";

import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workerRelease,
} from "../runtime/telemetry";

import {
  type DeliveryActivity as onboardingDeliveryActivity,
  internals as onboardingDeliveryInternals,
} from "./internal/onboarding-delivery";

import {
  type DeliveryActivity as pairingDeliveryActivity,
  internals as pairingDeliveryInternals,
  type DispatchEnvironment as pairingDispatchEnvironment,
} from "./internal/pairing-delivery";

import { internals as replacementDeliveryInternals } from "./internal/replacement-delivery";

const {
  deliveryState,
  Outbox: onboardingOutbox,
  Pending: onboardingPending,
  Work: onboardingWork,
  attempt: onboardingattempt,
  deliverOnboardingEmail: onboardingdeliverOnboardingEmail,
  pendingOutbox: onboardingpendingOutbox,
  proofLifetimeMs: onboardingproofLifetimeMs,
  publicationRetryMs: onboardingpublicationRetryMs,
  sendThroughResend,
} = onboardingDeliveryInternals;

export type OnboardingEmailEnvironment = Readonly<{
  DB: D1Database;
  ONBOARDING_EMAIL_QUEUE: Queue;
  ONBOARDING_EMAIL_WORKFLOW: Workflow;
  RESEND_API_KEY: string;
}>;

/** Reoffer at most 32 secret-free identities per tick, including unsettled publications. */
export const dispatchOnboardingEmail = (
  environment: Readonly<{
    DB: D1Database;
    ONBOARDING_EMAIL_QUEUE: {
      send: (work: typeof onboardingWork.Type) => Promise<unknown>;
    };
  }> & {
    readonly identity: Option.Option<string>;
  }
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const identity = environment.identity;
    const now = yield* Clock.currentTimeMillis;
    const result = yield* onboardingpendingOutbox(environment.DB, now, identity);
    const entries = yield* Schema.decodeUnknownEffect(Schema.Array(onboardingOutbox))(
      result.results
    ).pipe(Effect.mapError(() => undefined));
    let failed = false;
    for (const entry of entries) {
      // Claim a cooldown before Queue I/O so a failing oldest batch cannot starve newer work.
      const claimed = yield* Effect.exit(
        onboardingattempt(() =>
          environment.DB.prepare(`UPDATE onboarding_email_outbox SET last_attempt_at_ms = ?
          WHERE id = ? AND (last_attempt_at_ms IS NULL OR last_attempt_at_ms < ?)`)
            .bind(now, entry.id, now - onboardingpublicationRetryMs)
            .run()
        )
      );
      if (Exit.isFailure(claimed)) {
        failed = true;
        continue;
      }
      if (claimed.value.meta.changes !== 1) continue;
      // An offer and its D1 settlement are not atomic. Keep offering other identities if one fails.
      const offered = yield* Effect.exit(
        onboardingattempt(() =>
          environment.ONBOARDING_EMAIL_QUEUE.send({ version: entry.version, id: entry.id })
        )
      );
      if (Exit.isFailure(offered)) {
        failed = true;
        continue;
      }
      const settled = yield* Effect.exit(
        onboardingattempt(() =>
          environment.DB.prepare(`UPDATE onboarding_email_outbox
        SET published_at_ms = ? WHERE id = ?`)
            .bind(now, entry.id)
            .run()
        )
      );
      if (Exit.isFailure(settled)) failed = true;
    }
    if (failed) return yield* Effect.fail(undefined);
  });

/** A malformed queued identity cannot select an enrollment or start a Workflow. */
export const receiveOnboardingEmail =
  (
    environment: Readonly<{
      DB: D1Database;
      ONBOARDING_EMAIL_WORKFLOW: {
        create: (options: { id: string; params: typeof onboardingWork.Type }) => Promise<unknown>;
        get: (id: string) => Promise<unknown>;
      };
    }>
  ) =>
  (batch: MessageBatch<unknown>): Effect.Effect<void, void> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const message of batch.messages) {
        const decoded = Schema.decodeUnknownOption(onboardingWork)(message.body);
        if (decoded._tag === "None") {
          message.ack();
          continue;
        }
        const { id } = decoded.value;
        const row = yield* onboardingattempt(() =>
          environment.DB.prepare(`SELECT email_address, expires_at_ms, state
        FROM pending_email_enrollments WHERE id = ?`)
            .bind(id)
            .first()
        );
        if (row === null) {
          message.ack();
          continue;
        }
        const pending = yield* Schema.decodeUnknownEffect(onboardingPending)(row).pipe(
          Effect.mapError(() => undefined)
        );
        if (pending.state !== "awaiting_delivery" || pending.expires_at_ms <= now) {
          message.ack();
          continue;
        }
        // A deterministic instance identity makes a duplicate Queue message harmless.
        const started = yield* Effect.exit(
          onboardingattempt(() =>
            environment.ONBOARDING_EMAIL_WORKFLOW.create({ id, params: decoded.value })
          )
        );
        if (Exit.isFailure(started)) {
          // A create failure may mean the instance already exists; only a confirmed get settles it.
          yield* onboardingattempt(() => environment.ONBOARDING_EMAIL_WORKFLOW.get(id));
        }
        message.ack();
      }
    });

/** Resolve only versioned identity work; the Activity returns no proof material. */
export const runOnboardingEmailWorkflow = ({
  environment,
  payload,
  activity,
}: {
  environment: Pick<OnboardingEmailEnvironment, "DB" | "RESEND_API_KEY">;
  payload: unknown;
  activity: onboardingDeliveryActivity;
}): Promise<void> => {
  const decoded = Schema.decodeUnknownOption(onboardingWork)(payload);
  if (Option.isNone(decoded)) return Promise.resolve();
  return activity(
    "send-onboarding-verification-v1",
    { retries: { limit: 0, delay: "1 second" } },
    () => onboardingdeliverOnboardingEmail(environment)(decoded.value.id)
  );
};

/** Version 1 stores only a work identity; the named Activity never returns proof material. */
export class OnboardingEmailWorkflowV1 extends WorkflowEntrypoint<
  Pick<OnboardingEmailEnvironment, "DB" | "RESEND_API_KEY">,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return captureWorkflowFailure({
      work: observeWorkerPromise(
        () =>
          runOnboardingEmailWorkflow({
            environment: this.env,
            payload: event.payload,
            activity: (name, options, activity) => step.do(name, options, activity),
          }),
        {
          environment: workerRelease(this.env),
          telemetry: cloudflareWorkerTelemetry,
          operation: "workflow.onboardingEmail",
        }
      ),
      db: this.env.DB,
    });
  }
}

/** Recover an interrupted post-claim send as ambiguous, never as a reason to send again. */
export const reconcileOnboardingEmail = (db: D1Database): Effect.Effect<void, void> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    onboardingattempt(() =>
      db
        .prepare(`UPDATE pending_email_enrollments SET state = 'ambiguous'
      WHERE state = 'sending' AND proof_expires_at_ms < ?`)
        .bind(now - onboardingproofLifetimeMs)
        .run()
    ).pipe(Effect.asVoid)
  );

const {
  Outbox: pairingOutbox,
  Pending: pairingPending,
  Work: pairingWork,
  attempt: pairingattempt,
  deliverBrowserPairingEmail: pairingdeliverBrowserPairingEmail,
  dispatchCooldownMilliseconds: pairingdispatchCooldownMilliseconds,
  proofLifetimeMilliseconds: pairingproofLifetimeMilliseconds,
  publishWork: pairingpublishWork,
  sendPairingProof: pairingsendPairingProof,
} = pairingDeliveryInternals;

/** Offer at most 32 unexpired, secret-free email-work identities per scheduled tick. */
export const dispatchBrowserPairingEmail = (
  environment: pairingDispatchEnvironment & {
    readonly identity: Option.Option<string>;
  }
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const identity = environment.identity;
    const current = yield* Clock.currentTimeMillis;
    const rows = yield* pairingattempt(() =>
      environment.DB.prepare(`SELECT o.id
    FROM browser_pairing_email_outbox AS o
    JOIN browser_pairing_email_proofs AS e ON e.work_id = o.id
    JOIN browser_login_pairings AS p ON p.id = e.pairing_id
    WHERE e.state = 'awaiting_delivery' AND e.expires_at_ms > ?
      AND p.state = 'pending_approval' AND p.expires_at_ms > ?
      AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms < ?)
      AND (? IS NULL OR o.id = ?)
    ORDER BY o.created_at_ms LIMIT 32`)
        .bind(
          current,
          current,
          current - pairingdispatchCooldownMilliseconds,
          Option.getOrNull(identity),
          Option.getOrNull(identity)
        )
        .all()
    );
    const outbox = yield* Schema.decodeUnknownEffect(Schema.Array(pairingOutbox))(
      rows.results
    ).pipe(Effect.mapError(() => undefined));
    let failed = false;
    for (const entry of outbox) {
      const published = yield* Effect.exit(pairingpublishWork(environment, entry.id, current));
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
        const decoded = Schema.decodeUnknownOption(pairingWork)(message.body);
        if (Option.isNone(decoded)) {
          message.ack();
          continue;
        }
        const row = yield* pairingattempt(() =>
          environment.DB.prepare(`SELECT email_address, expires_at_ms, state
        FROM browser_pairing_email_proofs WHERE work_id = ?`)
            .bind(decoded.value.id)
            .first()
        );
        if (row === null) {
          message.ack();
          continue;
        }
        const pending = yield* Schema.decodeUnknownEffect(pairingPending)(row).pipe(
          Effect.mapError(() => undefined)
        );
        if (pending.state !== "awaiting_delivery" || pending.expires_at_ms <= current) {
          message.ack();
          continue;
        }
        const started = yield* Effect.exit(
          pairingattempt(() =>
            environment.BROWSER_PAIRING_EMAIL_WORKFLOW.create({
              id: decoded.value.id,
              params: decoded.value,
            })
          )
        );
        if (Exit.isFailure(started)) {
          yield* pairingattempt(() =>
            environment.BROWSER_PAIRING_EMAIL_WORKFLOW.get(decoded.value.id)
          );
        }
        message.ack();
      }
    });

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
    return captureWorkflowFailure({
      work: observeWorkerPromise(
        () =>
          runBrowserPairingEmailWorkflow({
            environment: this.env,
            payload: event.payload,
            activity: (name, options, activity) => step.do(name, options, activity),
          }),
        {
          environment: workerRelease(this.env),
          telemetry: cloudflareWorkerTelemetry,
          operation: "workflow.browserPairingEmail",
        }
      ),
      db: this.env.DB,
    });
  }
}

/** Validate the Queue payload again at the Workflow boundary before accessing D1. */
export const runBrowserPairingEmailWorkflow = ({
  environment,
  payload,
  activity,
}: {
  environment: Pick<BrowserPairingEmailEnvironment, "DB" | "RESEND_API_KEY">;
  payload: unknown;
  activity: pairingDeliveryActivity;
}): Promise<void> => {
  const work = Schema.decodeUnknownOption(pairingWork)(payload);
  if (Option.isNone(work)) return Promise.resolve();
  return activity(
    "send-browser-pairing-email-v1",
    { retries: { limit: 0, delay: "1 second" } },
    () =>
      pairingdeliverBrowserPairingEmail({
        db: environment.DB,
        send: pairingsendPairingProof(environment),
      })(work.value.id)
  );
};

/** Abandon interrupted claimed sends without ever reusing their unobservable raw proof. */
export const reconcileBrowserPairingEmail = (db: D1Database): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    yield* pairingattempt(() =>
      db
        .prepare(`UPDATE browser_pairing_email_proofs
      SET state = 'ambiguous', public_code = NULL, proof_digest = NULL, proof_expires_at_ms = NULL
      WHERE state = 'sending' AND proof_expires_at_ms < ?`)
        .bind(current - pairingproofLifetimeMilliseconds)
        .run()
    );
    yield* pairingattempt(() =>
      db
        .prepare(`DELETE FROM browser_pairing_email_outbox WHERE id IN
      (SELECT o.id FROM browser_pairing_email_outbox AS o LEFT JOIN browser_pairing_email_proofs AS p
        ON p.work_id = o.id WHERE p.work_id IS NULL OR p.expires_at_ms <= ?
        OR p.state IN ('approved', 'rejected', 'ambiguous') ORDER BY o.created_at_ms LIMIT 32)`)
        .bind(current)
        .run()
    );
    yield* pairingattempt(() =>
      db
        .prepare(`DELETE FROM browser_pairing_email_proofs WHERE pairing_id IN
      (SELECT pairing_id FROM browser_pairing_email_proofs WHERE expires_at_ms <= ? LIMIT 32)`)
        .bind(current)
        .run()
    );
  });

const {
  Outbox: replacementOutbox,
  Pending: replacementPending,
  Work: replacementWork,
  attempt: replacementattempt,
  deliverEmailReplacement: replacementdeliverEmailReplacement,
  dispatchCooldownMilliseconds: replacementdispatchCooldownMilliseconds,
  proofLifetimeMilliseconds: replacementproofLifetimeMilliseconds,
} = replacementDeliveryInternals;

export type EmailReplacementEnvironment = {
  DB: D1Database;
  EMAIL_REPLACEMENT_QUEUE: {
    send: (work: typeof replacementWork.Type) => Promise<unknown>;
  };
  EMAIL_REPLACEMENT_WORKFLOW: Workflow;
  RESEND_API_KEY: string;
};

/** Publish bounded durable work identities; no mailbox or proof leaves D1 in the Queue. */
export const dispatchEmailReplacement = (
  environment: Pick<EmailReplacementEnvironment, "DB" | "EMAIL_REPLACEMENT_QUEUE"> & {
    readonly identity: Option.Option<string>;
  }
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const identity = environment.identity;
    const current = yield* Clock.currentTimeMillis;
    const rows = yield* replacementattempt(() =>
      environment.DB.prepare(`SELECT o.id FROM email_replacement_outbox AS o
      JOIN email_replacements AS r ON r.work_id = o.id
      WHERE r.state = 'awaiting_delivery' AND r.expires_at_ms > ?
        AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms < ?)
        AND (? IS NULL OR o.id = ?)
      ORDER BY o.created_at_ms LIMIT 32`)
        .bind(
          current,
          current - replacementdispatchCooldownMilliseconds,
          Option.getOrNull(identity),
          Option.getOrNull(identity)
        )
        .all()
    );
    const entries = yield* Schema.decodeUnknownEffect(Schema.Array(replacementOutbox))(
      rows.results
    ).pipe(Effect.mapError(() => undefined));
    for (const entry of entries) {
      const claimed = yield* replacementattempt(() =>
        environment.DB.prepare(`UPDATE email_replacement_outbox
        SET last_attempt_at_ms = ? WHERE id = ? AND (last_attempt_at_ms IS NULL OR last_attempt_at_ms < ?)`)
          .bind(current, entry.id, current - replacementdispatchCooldownMilliseconds)
          .run()
      );
      if (claimed.meta.changes === 1) {
        yield* replacementattempt(() =>
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
  Option.isSome(
    Schema.decodeUnknownOption(Schema.Struct({ kind: Schema.Literal("email-replacement") }))(value)
  );

/** Recheck D1 state before starting the durable delivery Activity. */
export const receiveEmailReplacement =
  (environment: Pick<EmailReplacementEnvironment, "DB" | "EMAIL_REPLACEMENT_WORKFLOW">) =>
  (batch: MessageBatch<unknown>): Effect.Effect<void, void> =>
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      for (const message of batch.messages) {
        const work = Schema.decodeUnknownOption(replacementWork)(message.body);
        if (Option.isNone(work)) {
          message.ack();
          continue;
        }
        const raw = yield* replacementattempt(() =>
          environment.DB.prepare(`SELECT candidate_email, expires_at_ms, state
        FROM email_replacements WHERE work_id = ?`)
            .bind(work.value.id)
            .first()
        );
        const pending = Schema.decodeUnknownOption(replacementPending)(raw);
        if (
          Option.isNone(pending) ||
          pending.value.state !== "awaiting_delivery" ||
          pending.value.expires_at_ms <= current
        ) {
          message.ack();
          continue;
        }
        const started = yield* Effect.exit(
          replacementattempt(() =>
            environment.EMAIL_REPLACEMENT_WORKFLOW.create({ id: work.value.id, params: work.value })
          )
        );
        if (Exit.isFailure(started)) {
          yield* replacementattempt(() =>
            environment.EMAIL_REPLACEMENT_WORKFLOW.get(work.value.id)
          );
        }
        message.ack();
      }
    });

/** Versioned Activity sends the only raw mailbox proof through the fixed Resend boundary. */
export class EmailReplacementWorkflowV1 extends WorkflowEntrypoint<
  EmailReplacementEnvironment,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return captureWorkflowFailure({
      work: observeWorkerPromise(
        () => {
          const work = Schema.decodeUnknownOption(replacementWork)(event.payload);
          if (Option.isNone(work)) return Promise.resolve();
          return step.do(
            "send-email-replacement-v1",
            { retries: { limit: 0, delay: "1 second" } },
            () =>
              Effect.tryPromise({
                try: () =>
                  replacementdeliverEmailReplacement({
                    db: this.env.DB,
                    send: (to, code, id) =>
                      sendThroughResend({
                        purpose: "credential-replacement",
                        environment: this.env,
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
        },
        {
          environment: workerRelease(this.env),
          telemetry: cloudflareWorkerTelemetry,
          operation: "workflow.emailReplacement",
        }
      ),
      db: this.env.DB,
    });
  }
}

/** Bound retention and abandon interrupted sends without reusing unobservable raw proofs. */
export const reconcileEmailReplacement = (db: D1Database): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    yield* replacementattempt(() =>
      db
        .prepare(`UPDATE email_replacements SET state = 'ambiguous', public_code = NULL,
    proof_digest = NULL, proof_expires_at_ms = NULL WHERE state = 'sending' AND proof_expires_at_ms < ?`)
        .bind(current - replacementproofLifetimeMilliseconds)
        .run()
    );
    yield* replacementattempt(() =>
      db
        .prepare(`DELETE FROM email_replacement_outbox WHERE id IN
    (SELECT o.id FROM email_replacement_outbox AS o LEFT JOIN email_replacements AS r ON r.work_id = o.id
      WHERE r.work_id IS NULL OR r.expires_at_ms <= ? OR r.state IN ('rejected', 'ambiguous') LIMIT 32)`)
        .bind(current)
        .run()
    );
    yield* replacementattempt(() =>
      db
        .prepare(`DELETE FROM email_replacements WHERE user_id IN
    (SELECT user_id FROM email_replacements WHERE expires_at_ms <= ? LIMIT 32)`)
        .bind(current)
        .run()
    );
  });
