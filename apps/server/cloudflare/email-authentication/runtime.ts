import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Effect } from "effect";
import type {
  BrowserPairingEmailEnvironment,
  BrowserPairingEmailPublisher,
  EmailDeliveryEnvironment,
  EmailPublication,
  EmailReplacementEnvironment,
  EmailReplacementPublisher,
  EmailWorkflowInput,
  OnboardingEmailPublisher,
  OnboardingEmailStarter,
} from "./contract";
import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workerRelease,
} from "../runtime/telemetry";
import { captureWorkflowFailure } from "../runtime/operational-workflow-failure";
import {
  dispatchOnboardingEmail as dispatchOnboarding,
  receiveOnboardingEmail as receiveOnboarding,
  reconcileOnboardingEmail as reconcileOnboarding,
  runOnboardingEmailWorkflow as runOnboarding,
} from "./internal/onboarding-workflow";
import {
  dispatchBrowserPairingEmail as dispatchPairing,
  receiveBrowserPairingEmail as receivePairing,
  isBrowserPairingEmailWork as recognizesPairing,
  reconcileBrowserPairingEmail as reconcilePairing,
  runBrowserPairingEmailWorkflow as runPairing,
} from "./internal/browser-pairing-workflow";
import {
  dispatchEmailReplacement as dispatchReplacement,
  receiveEmailReplacement as receiveReplacement,
  isEmailReplacementWork as recognizesReplacement,
  reconcileEmailReplacement as reconcileReplacement,
  runEmailReplacementWorkflow as runReplacement,
} from "./internal/replacement-workflow";
/** Offer bounded OnboardingEmail intents; a missed Queue offer remains durably recoverable. */
export const dispatchOnboardingEmail = (
  input: Readonly<{ DB: D1Database; ONBOARDING_EMAIL_QUEUE: OnboardingEmailPublisher }> &
    EmailPublication
): Effect.Effect<void, void> => dispatchOnboarding(input);
/** Validate each Queue identity, recheck its current owner state and hand it to the deterministic Workflow. */
export const receiveOnboardingEmail =
  (environment: Readonly<{ DB: D1Database; ONBOARDING_EMAIL_WORKFLOW: OnboardingEmailStarter }>) =>
  (batch: MessageBatch<unknown>): Effect.Effect<void, void> =>
    receiveOnboarding(environment)(batch);
/** Recover interrupted sends as ambiguous and perform only the owner's bounded retention. */
export const reconcileOnboardingEmail = (db: D1Database): Effect.Effect<void, void> =>
  reconcileOnboarding(db);
/** Execute a versioned identity-only Workflow; the private Activity retains no raw proof or mailbox. */
export const runOnboardingEmailWorkflow = (input: EmailWorkflowInput): Promise<void> =>
  runOnboarding(input);
/** Version 1 delegates only bounded delivery; persisted payloads and Activity names are unchanged. */
export class OnboardingEmailWorkflowV1 extends WorkflowEntrypoint<
  EmailDeliveryEnvironment,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return captureWorkflowFailure({
      work: observeWorkerPromise(
        () =>
          runOnboarding({
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
/** Offer bounded BrowserPairingEmail intents; a missed Queue offer remains durably recoverable. */
export const dispatchBrowserPairingEmail = (
  input: Readonly<{ DB: D1Database; BROWSER_PAIRING_EMAIL_QUEUE: BrowserPairingEmailPublisher }> &
    EmailPublication
): Effect.Effect<void, void> => dispatchPairing(input);
/** Validate each Queue identity, recheck its current owner state and hand it to the deterministic Workflow. */
export const receiveBrowserPairingEmail =
  (environment: Pick<BrowserPairingEmailEnvironment, "DB" | "BROWSER_PAIRING_EMAIL_WORKFLOW">) =>
  (batch: MessageBatch<unknown>): Effect.Effect<void, void> =>
    receivePairing(environment)(batch);
/** Recover interrupted sends as ambiguous and perform only the owner's bounded retention. */
export const reconcileBrowserPairingEmail = (db: D1Database): Effect.Effect<void, void> =>
  reconcilePairing(db);
/** Execute a versioned identity-only Workflow; the private Activity retains no raw proof or mailbox. */
export const runBrowserPairingEmailWorkflow = (input: EmailWorkflowInput): Promise<void> =>
  runPairing(input);
/** Select this Queue protocol without interpreting it as authority. */
export const isBrowserPairingEmailWork = (value: unknown): boolean => recognizesPairing(value);
/** Version 1 delegates only bounded delivery; persisted payloads and Activity names are unchanged. */
export class BrowserPairingEmailWorkflowV1 extends WorkflowEntrypoint<
  EmailDeliveryEnvironment,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return captureWorkflowFailure({
      work: observeWorkerPromise(
        () =>
          runPairing({
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
/** Offer bounded EmailReplacement intents; a missed Queue offer remains durably recoverable. */
export const dispatchEmailReplacement = (
  input: Readonly<{ DB: D1Database; EMAIL_REPLACEMENT_QUEUE: EmailReplacementPublisher }> &
    EmailPublication
): Effect.Effect<void, void> => dispatchReplacement(input);
/** Validate each Queue identity, recheck its current owner state and hand it to the deterministic Workflow. */
export const receiveEmailReplacement =
  (environment: Pick<EmailReplacementEnvironment, "DB" | "EMAIL_REPLACEMENT_WORKFLOW">) =>
  (batch: MessageBatch<unknown>): Effect.Effect<void, void> =>
    receiveReplacement(environment)(batch);
/** Recover interrupted sends as ambiguous and perform only the owner's bounded retention. */
export const reconcileEmailReplacement = (db: D1Database): Effect.Effect<void, void> =>
  reconcileReplacement(db);
/** Execute a versioned identity-only Workflow; the private Activity retains no raw proof or mailbox. */
export const runEmailReplacementWorkflow = (input: EmailWorkflowInput): Promise<void> =>
  runReplacement(input);
/** Select this Queue protocol without interpreting it as authority. */
export const isEmailReplacementWork = (value: unknown): boolean => recognizesReplacement(value);
/** Version 1 delegates only bounded delivery; persisted payloads and Activity names are unchanged. */
export class EmailReplacementWorkflowV1 extends WorkflowEntrypoint<
  EmailDeliveryEnvironment,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return captureWorkflowFailure({
      work: observeWorkerPromise(
        () =>
          runReplacement({
            environment: this.env,
            payload: event.payload,
            activity: (name, options, activity) => step.do(name, options, activity),
          }),
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
