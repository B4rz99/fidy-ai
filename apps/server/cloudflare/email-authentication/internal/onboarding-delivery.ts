import { EmailAddress, EmailVerificationCode } from "@fidy/server/client";

import type { EmailDeliveryPortService } from "@fidy/server/email-authentication-contract";

import { makeOnboardingEmailDelivery } from "@fidy/server/email-authentication-runtime";

import type { WorkflowStepConfig } from "cloudflare:workers";

import { Cause, Clock, Context, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";

import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { cloudflareWorkerTelemetry, observeProviderFetch } from "../../runtime/telemetry";

import type { OnboardingEmailEnvironment } from "../runtime";

type EmailDeliveryFailure = {
  readonly certainty: "rejected" | "ambiguous";
  readonly retryable: boolean;
};

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

const proofLifetimeMs = 600000;

const maximumDispatchEntries = 32;

const publicationRetryMs = 60000;

const group = (text: string): string => text.match(/.{1,4}/gu)?.join("-") ?? "";

const randomSymbols = (length: number): string =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(length)),
    (byte) => alphabet[byte % alphabet.length]
  ).join("");

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });

const pendingOutbox = (
  db: D1Database,
  now: number,
  identity: Option.Option<string>
): Effect.Effect<D1Result, void> =>
  attempt(() =>
    db
      .prepare(`SELECT o.id, o.version
      FROM onboarding_email_outbox AS o JOIN pending_email_enrollments AS e ON e.id = o.id
      WHERE e.state = 'awaiting_delivery' AND e.expires_at_ms > ?
        AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms < ?)
        AND (? IS NULL OR o.id = ?)
      ORDER BY (o.last_attempt_at_ms IS NOT NULL), o.last_attempt_at_ms, o.created_at_ms LIMIT ?`)
      .bind(
        now,
        now - publicationRetryMs,
        Option.getOrNull(identity),
        Option.getOrNull(identity),
        maximumDispatchEntries
      )
      .all()
  );

export type DeliveryActivity = (
  name: string,
  options: WorkflowStepConfig,
  run: () => Promise<void>
) => Promise<void>;

const sendThroughResend = (
  input: Readonly<{
    purpose: Parameters<EmailDeliveryPortService["send"]>[0]["purpose"];
    environment: Pick<OnboardingEmailEnvironment, "RESEND_API_KEY">;
    to: EmailAddress;
    combinedCode: EmailVerificationCode;
    id: string;
  }>
): Promise<Exit.Exit<void, EmailDeliveryFailure>> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* Layer.build(FetchHttpClient.layer).pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            observeProviderFetch(globalThis.fetch, {
              provider: "resend",
              environment: input.environment,
              telemetry: cloudflareWorkerTelemetry,
            })
          )
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

const deliveryState = (
  outcome: Exit.Exit<void, EmailDeliveryFailure>
): "awaiting_proof" | "rejected" | "ambiguous" => {
  if (Exit.isSuccess(outcome)) return "awaiting_proof";
  const failure = Cause.findErrorOption(outcome.cause);
  return Option.isSome(failure) && failure.value.certainty === "rejected"
    ? "rejected"
    : "ambiguous";
};

/** One claimed Activity invocation: never repeats a send when its prior result was lost. */
const deliverOnboardingEmail =
  (environment: Pick<OnboardingEmailEnvironment, "DB" | "RESEND_API_KEY">) =>
  (id: string): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const raw = yield* attempt(() =>
          environment.DB.prepare(`SELECT email_address, expires_at_ms, state
    FROM pending_email_enrollments WHERE id = ?`)
            .bind(id)
            .first()
        );
        if (raw === null) return;
        const pending = Schema.decodeUnknownOption(Pending)(raw);
        if (Option.isNone(pending)) return;
        if (!canClaim(pending.value, yield* Clock.currentTimeMillis)) return;
        const publicCode = group(randomSymbols(publicSymbols));
        const proof = group(randomSymbols(proofSymbols));
        const combinedCode = yield* Schema.decodeEffect(EmailVerificationCode)(
          `${publicCode}-${proof}`
        ).pipe(Effect.orDie);
        const digest = new Uint8Array(
          yield* attempt(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof)))
        );
        // The claim and digest commit before the outbound call. Restarting this Activity cannot resend.
        const now = yield* Clock.currentTimeMillis;
        const claim = yield* attempt(() =>
          environment.DB.prepare(`UPDATE pending_email_enrollments
    SET state = 'sending', public_code = ?, proof_digest = ?, proof_expires_at_ms = ?
    WHERE id = ? AND state = 'awaiting_delivery' AND expires_at_ms > ?`)
            .bind(
              publicCode,
              digest,
              Math.min(now + proofLifetimeMs, pending.value.expires_at_ms),
              id,
              now
            )
            .run()
        );
        if (claim.meta.changes !== 1) return;
        // The step retains no proof or provider body; state is D1-owned.
        const outcome = yield* attempt(() =>
          sendThroughResend({
            purpose: "verified-onboarding",
            environment,
            to: pending.value.email_address,
            combinedCode,
            id,
          })
        );
        yield* attempt(() =>
          environment.DB.prepare(`UPDATE pending_email_enrollments SET state = ?
    WHERE id = ? AND state = 'sending'`)
            .bind(deliveryState(outcome), id)
            .run()
        );
      })
    );

export const internals = {
  Work,
  Pending,
  Outbox,
  canClaim,
  alphabet,
  publicSymbols,
  proofSymbols,
  proofLifetimeMs,
  maximumDispatchEntries,
  publicationRetryMs,
  group,
  randomSymbols,
  attempt,
  pendingOutbox,
  sendThroughResend,
  deliveryState,
  deliverOnboardingEmail,
};
