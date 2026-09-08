import { Cause, Effect, Exit, Option } from "effect";
import { dual } from "effect/Function";
import {
  type DeclaredOutcome,
  type SpanDescriptor,
  TelemetryAttempt,
} from "~/shell/observability/protocol";
import { Telemetry, type TelemetryService } from "~/shell/observability/telemetry";
import type { DisclosureDeliveryAttemptNumber } from "./disclosure-model";

const recordExit = (
  telemetry: TelemetryService,
  exit: Exit.Exit<unknown, unknown>,
  descriptor: SpanDescriptor
): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) return Effect.void;
  const cause = exit.cause;
  if (Cause.hasInterrupts(cause) && !Cause.hasDies(cause) && !Cause.hasFails(cause)) {
    return telemetry.recordOutcome({
      outcome: "interrupted",
      error: Option.none(),
      retryable: false,
    });
  }
  const defect = Cause.hasDies(cause);
  const error = defect ? "unexpected_defect" : "operational_failure";
  return telemetry
    .recordOutcome({ outcome: "failed", error: Option.some(error), retryable: !defect })
    .pipe(
      Effect.andThen(
        telemetry.captureFailure(
          defect
            ? {
                _tag: "Defect",
                component: "whatsapp",
                operation: descriptor.operation,
                error,
                cause,
              }
            : {
                _tag: "ExhaustedOperationalFailure",
                component: "whatsapp",
                operation: descriptor.operation,
                error,
                provider: Option.none(),
                retryable: true,
                cause,
              }
        )
      )
    );
};

const observe = <A, E, R>(
  work: Effect.Effect<A, E, R>,
  descriptor: SpanDescriptor
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const telemetry = yield* Effect.serviceOption(Telemetry);
    if (Option.isNone(telemetry)) return yield* work;
    return yield* telemetry.value.span(
      descriptor,
      Effect.onExit(work, (exit) => recordExit(telemetry.value, exit, descriptor))
    );
  });

/** Finite provider Activity owns its escaped failures. Keep it disjoint from observed resume Work. */
export const observeConsentDisclosureAttempt: {
  (
    attempt: DisclosureDeliveryAttemptNumber
  ): <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(
    work: Effect.Effect<A, E, R>,
    attempt: DisclosureDeliveryAttemptNumber
  ): Effect.Effect<A, E, R>;
} = dual(
  2,
  <A, E, R>(
    work: Effect.Effect<A, E, R>,
    attempt: DisclosureDeliveryAttemptNumber
  ): Effect.Effect<A, E, R> =>
    observe(work, {
      component: "whatsapp",
      operation: "whatsapp.disclosureAttempt",
      trigger: "queue",
      spanOperation: "http.client",
      workKind: "provider_call",
      metadata: {
        _tag: "Provider",
        provider: "kapso",
        attempt: TelemetryAttempt.make(attempt),
        status: Option.none(),
      },
    })
);

/** One finite owner snapshot/decision. Keep provider Activities, durable waits, and workflow lifetime outside. */
export const observeConsentDisclosureResume = <A, E, R>(
  work: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  observe(work, {
    component: "whatsapp",
    operation: "whatsapp.disclosureResume",
    trigger: "queue",
    spanOperation: "fidy.operation",
    workKind: "canonical_operation",
    metadata: { _tag: "None" },
  });

/** Wrap the native take handler, not its blocking wait or an infinite loop. This owns escaped failures. */
export const observeConsentDisclosureQueue: {
  (kind: "start" | "evidence"): <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(work: Effect.Effect<A, E, R>, kind: "start" | "evidence"): Effect.Effect<A, E, R>;
} = dual(
  2,
  <A, E, R>(work: Effect.Effect<A, E, R>, kind: "start" | "evidence"): Effect.Effect<A, E, R> =>
    observe(work, {
      component: "whatsapp",
      operation: kind === "start" ? "whatsapp.disclosureStart" : "whatsapp.disclosureEvidence",
      trigger: "queue",
      spanOperation: "queue.process",
      workKind: "canonical_operation",
      metadata: { _tag: "None" },
    })
);

const ownerOutcomes = {
  sent: { outcome: "succeeded", error: Option.none(), retryable: false },
  delivered: { outcome: "succeeded", error: Option.none(), retryable: false },
  "not-current": {
    outcome: "rejected",
    error: Option.some("disclosure_not_current"),
    retryable: false,
  },
  ambiguous: { outcome: "failed", error: Option.some("disclosure_ambiguous"), retryable: false },
  retrying: { outcome: "failed", error: Option.some("disclosure_retrying"), retryable: true },
  rejected: { outcome: "rejected", error: Option.some("disclosure_rejected"), retryable: false },
  "retry-exhausted": {
    outcome: "failed",
    error: Option.some("disclosure_retry_exhausted"),
    retryable: false,
  },
} as const satisfies Record<string, DeclaredOutcome>;

/** Declares owner evidence within finite Work; rejected/exhausted does not mean native execution ended. */
export const recordConsentDisclosureOutcome = (
  outcome: keyof typeof ownerOutcomes
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const telemetry = yield* Effect.serviceOption(Telemetry);
    if (Option.isSome(telemetry)) yield* telemetry.value.recordOutcome(ownerOutcomes[outcome]);
  });
