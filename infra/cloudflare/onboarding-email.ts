import { EmailAddress, EmailVerificationCode } from "@fidy/server/client";
import type { EmailDeliveryPortService } from "@fidy/server/onboarding-email-delivery";
import {
  type EmailSendFailed,
  makeOnboardingEmailDelivery,
} from "@fidy/server/onboarding-email-delivery";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

const Work = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID()),
});
const Pending = Schema.Struct({
  email_address: EmailAddress,
  expires_at_ms: Schema.Finite,
  state: Schema.Literals([
    "awaiting_delivery",
    "sending",
    "awaiting_proof",
    "rejected",
    "ambiguous",
  ]),
});
const Outbox = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  version: Schema.Literal(1),
});
const canClaim = (pending: typeof Pending.Type, now: number): boolean =>
  pending.state === "awaiting_delivery" && pending.expires_at_ms > now;
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const publicSymbols = 8;
const proofSymbols = 16;
const proofLifetimeMs = 600_000;
const maximumDispatchEntries = 32;
const publicationRetryMs = 60_000;
const group = (text: string): string => text.match(/.{1,4}/gu)?.join("-") ?? "";
const randomSymbols = (length: number): string =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(length)),
    (byte) => alphabet[byte % alphabet.length]
  ).join("");
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });

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
    ONBOARDING_EMAIL_QUEUE: { send: (work: typeof Work.Type) => Promise<unknown> };
  }>
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const result = yield* attempt(() =>
      environment.DB.prepare(`SELECT o.id, o.version
      FROM onboarding_email_outbox AS o JOIN pending_email_enrollments AS e ON e.id = o.id
      WHERE e.state = 'awaiting_delivery' AND e.expires_at_ms > ?
        AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms < ?)
      ORDER BY (o.last_attempt_at_ms IS NOT NULL), o.last_attempt_at_ms, o.created_at_ms LIMIT ?`)
        .bind(now, now - publicationRetryMs, maximumDispatchEntries)
        .all()
    );
    const entries = yield* Schema.decodeUnknownEffect(Schema.Array(Outbox))(result.results).pipe(
      Effect.mapError(() => undefined)
    );
    let failed = false;
    for (const entry of entries) {
      // Claim a cooldown before Queue I/O so a failing oldest batch cannot starve newer work.
      const claimed = yield* Effect.exit(
        attempt(() =>
          environment.DB.prepare(`UPDATE onboarding_email_outbox SET last_attempt_at_ms = ?
          WHERE id = ? AND (last_attempt_at_ms IS NULL OR last_attempt_at_ms < ?)`)
            .bind(now, entry.id, now - publicationRetryMs)
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
        attempt(() =>
          environment.ONBOARDING_EMAIL_QUEUE.send({ version: entry.version, id: entry.id })
        )
      );
      if (Exit.isFailure(offered)) {
        failed = true;
        continue;
      }
      const settled = yield* Effect.exit(
        attempt(() =>
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
        create: (options: { id: string; params: typeof Work.Type }) => Promise<unknown>;
        get: (id: string) => Promise<unknown>;
      };
    }>
  ) =>
  (batch: MessageBatch<unknown>): Effect.Effect<void, void> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const message of batch.messages) {
        const decoded = Schema.decodeUnknownOption(Work)(message.body);
        if (decoded._tag === "None") {
          message.ack();
          continue;
        }
        const { id } = decoded.value;
        const row = yield* attempt(() =>
          environment.DB.prepare(`SELECT email_address, expires_at_ms, state
        FROM pending_email_enrollments WHERE id = ?`)
            .bind(id)
            .first()
        );
        if (row === null) {
          message.ack();
          continue;
        }
        const pending = yield* Schema.decodeUnknownEffect(Pending)(row).pipe(
          Effect.mapError(() => undefined)
        );
        if (pending.state !== "awaiting_delivery" || pending.expires_at_ms <= now) {
          message.ack();
          continue;
        }
        // A deterministic instance identity makes a duplicate Queue message harmless.
        const started = yield* Effect.exit(
          attempt(() => environment.ONBOARDING_EMAIL_WORKFLOW.create({ id, params: decoded.value }))
        );
        if (Exit.isFailure(started)) {
          // A create failure may mean the instance already exists; only a confirmed get settles it.
          yield* attempt(() => environment.ONBOARDING_EMAIL_WORKFLOW.get(id));
        }
        message.ack();
      }
    });

type DeliveryActivity = (
  name: string,
  options: WorkflowStepConfig,
  run: () => Promise<void>
) => Promise<void>;

/** Resolve only versioned identity work; the Activity returns no proof material. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const runOnboardingEmailWorkflow = (
  environment: Pick<OnboardingEmailEnvironment, "DB" | "RESEND_API_KEY">,
  payload: unknown,
  activity: DeliveryActivity
): Promise<void> => {
  const decoded = Schema.decodeUnknownOption(Work)(payload);
  if (Option.isNone(decoded)) return Promise.resolve();
  return activity(
    "send-onboarding-verification-v1",
    { retries: { limit: 0, delay: "1 second" } },
    () => deliverOnboardingEmail(environment)(decoded.value.id)
  );
};

/** Version 1 stores only a work identity; the named Activity never returns proof material. */
export class OnboardingEmailWorkflowV1 extends WorkflowEntrypoint<
  Pick<OnboardingEmailEnvironment, "DB" | "RESEND_API_KEY">,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return runOnboardingEmailWorkflow(this.env, event.payload, (name, options, activity) =>
      step.do(name, options, activity)
    );
  }
}

export const sendThroughResend = (
  input: Readonly<{
    purpose: Parameters<EmailDeliveryPortService["send"]>[0]["purpose"];
    environment: Pick<OnboardingEmailEnvironment, "RESEND_API_KEY">;
    to: EmailAddress;
    combinedCode: EmailVerificationCode;
    id: string;
  }>
): Promise<Exit.Exit<void, EmailSendFailed>> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* Layer.build(FetchHttpClient.layer).pipe(
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
        );
        return yield* makeOnboardingEmailDelivery({
          apiKey: Redacted.make(input.environment.RESEND_API_KEY),
          httpClient: Context.get(clients, HttpClient.HttpClient),
        }).send({
          purpose: input.purpose,
          to: input.to,
          combinedCode: input.combinedCode,
          idempotencyKey: input.id,
        });
      })
    )
  );

export const deliveryState = (
  outcome: Exit.Exit<void, EmailSendFailed>
): "awaiting_proof" | "rejected" | "ambiguous" => {
  if (Exit.isSuccess(outcome)) return "awaiting_proof";
  const failure = Cause.findErrorOption(outcome.cause);
  return Option.isSome(failure) && failure.value.certainty === "rejected"
    ? "rejected"
    : "ambiguous";
};

/** One claimed Activity invocation: never repeats a send when its prior result was lost. */
export const deliverOnboardingEmail =
  (environment: Pick<OnboardingEmailEnvironment, "DB" | "RESEND_API_KEY">) =>
  // @effect-diagnostics-next-line asyncFunction:off
  async (id: string): Promise<void> => {
    const raw = await environment.DB.prepare(`SELECT email_address, expires_at_ms, state
    FROM pending_email_enrollments WHERE id = ?`)
      .bind(id)
      .first();
    if (raw === null) return;
    const pending = Schema.decodeUnknownOption(Pending)(raw);
    if (Option.isNone(pending)) return;
    // @effect-diagnostics-next-line globalDate:off
    if (!canClaim(pending.value, Date.now())) return;
    const publicCode = group(randomSymbols(publicSymbols));
    const proof = group(randomSymbols(proofSymbols));
    const combinedCode = Schema.decodeSync(EmailVerificationCode)(`${publicCode}-${proof}`);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof))
    );
    // The claim and digest commit before the outbound call. Restarting this Activity cannot resend.
    // @effect-diagnostics-next-line globalDate:off
    const now = Date.now();
    const claim = await environment.DB.prepare(`UPDATE pending_email_enrollments
    SET state = 'sending', public_code = ?, proof_digest = ?, proof_expires_at_ms = ?
    WHERE id = ? AND state = 'awaiting_delivery' AND expires_at_ms > ?`)
      .bind(
        publicCode,
        digest,
        Math.min(now + proofLifetimeMs, pending.value.expires_at_ms),
        id,
        now
      )
      .run();
    if (claim.meta.changes !== 1) return;
    // The step retains no proof or provider body; state is D1-owned.
    const outcome = await sendThroughResend({
      purpose: "verified-onboarding",
      environment,
      to: pending.value.email_address,
      combinedCode,
      id,
    });
    await environment.DB.prepare(`UPDATE pending_email_enrollments SET state = ?
    WHERE id = ? AND state = 'sending'`)
      .bind(deliveryState(outcome), id)
      .run();
  };

/** Recover an interrupted post-claim send as ambiguous, never as a reason to send again. */
export const reconcileOnboardingEmail = (db: D1Database): Effect.Effect<void, void> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    attempt(() =>
      db
        .prepare(`UPDATE pending_email_enrollments SET state = 'ambiguous'
      WHERE state = 'sending' AND proof_expires_at_ms < ?`)
        .bind(now - proofLifetimeMs)
        .run()
    ).pipe(Effect.asVoid)
  );
