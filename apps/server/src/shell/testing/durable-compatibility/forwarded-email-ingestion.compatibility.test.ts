// Node crypto is the focused synchronous digest implementation for this deterministic fixture.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { it } from "@effect/vitest";
import { Crypto, Effect, Schema } from "effect";
import { describe } from "vitest";
import {
  ForwardedEmailWorkflow,
  ForwardedEmailWorkflowPayload,
  ForwardedEmailWorkflowSuccess,
  forwardedEmailQueueId,
  forwardedEmailQueueName,
} from "~/shell/ingestion/forwarded-email-execution";
import {
  forwardedEmailActivityIdentities,
  forwardedEmailAllowanceClockName,
  forwardedEmailConsentClockName,
} from "~/shell/ingestion/forwarded-email-workflow";
import {
  type DurableWorkflowSpec,
  assertDurableWorkflowFixture,
  durableClockSpec,
  durableQueueSpec,
  loadDurableWorkflowFixture,
} from "~/shell/testing/durable-compatibility";

const queueCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (algorithm, data) => Effect.sync(() => createHash(algorithm).update(data).digest()),
});

const spec: DurableWorkflowSpec = {
  workflow: ForwardedEmailWorkflow,
  payloadSchema: ForwardedEmailWorkflowPayload,
  successSchema: ForwardedEmailWorkflowSuccess,
  errorSchema: Schema.Never,
  activities: {
    "apply-access": forwardedEmailActivityIdentities.applyAccess,
    "resume-access": forwardedEmailActivityIdentities.resumeAccess,
    retrieve: forwardedEmailActivityIdentities.retrieve,
    "resume-retrieval-consent": forwardedEmailActivityIdentities.resumeRetrievalConsent,
    interpret: forwardedEmailActivityIdentities.interpret,
    "resume-interpretation-consent": forwardedEmailActivityIdentities.resumeInterpretationConsent,
    settle: forwardedEmailActivityIdentities.settle,
    "settle-retrieval-failure": forwardedEmailActivityIdentities.settleRetrievalFailure,
    "resume-settlement-consent": forwardedEmailActivityIdentities.resumeSettlementConsent,
  },
  clocks: {
    "retrieve-1": durableClockSpec(
      forwardedEmailConsentClockName({ phase: "Retrieval", attempt: 1 })
    ),
    "retrieve-2": durableClockSpec(
      forwardedEmailConsentClockName({ phase: "Retrieval", attempt: 2 })
    ),
    "interpretation-consent-1": durableClockSpec(
      forwardedEmailConsentClockName({ phase: "Interpretation", attempt: 1 })
    ),
    "settlement-consent-1": durableClockSpec(
      forwardedEmailConsentClockName({ phase: "Settlement", attempt: 1 })
    ),
    "allowance-1": durableClockSpec(
      forwardedEmailAllowanceClockName({ suffix: "Allowance", attempt: 1 })
    ),
    "retrieve-allow-1": durableClockSpec(
      forwardedEmailAllowanceClockName({ suffix: "RetrievalConsentAllowance", attempt: 1 })
    ),
    "interpret-allow-1": durableClockSpec(
      forwardedEmailAllowanceClockName({ suffix: "InterpretationConsentAllowance", attempt: 1 })
    ),
    "settlement-consent-allowance-1": durableClockSpec(
      forwardedEmailAllowanceClockName({ suffix: "SettlementConsentAllowance", attempt: 1 })
    ),
  },
  deferreds: {},
  queues: [
    durableQueueSpec({
      key: "ingestion",
      name: forwardedEmailQueueName,
      schema: ForwardedEmailWorkflowPayload,
      queueId: (payload) =>
        forwardedEmailQueueId(payload).pipe(
          Effect.provideService(Crypto.Crypto, queueCrypto),
          Effect.orDie
        ),
    }),
  ],
};

describe("ForwardedEmailIngestion durable compatibility", () => {
  it.effect("decodes every checked-in persisted boundary and re-encodes it", () =>
    assertDurableWorkflowFixture(loadDurableWorkflowFixture("forwarded-email-ingestion"), spec)
  );
});
