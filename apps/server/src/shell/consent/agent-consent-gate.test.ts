import { expect, layer } from "@effect/vitest";
import { DateTime, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { MigrationSqlClient } from "~/shell/db/client";
import { ConsentRecord, ConsentRecordId } from "~/core/consent/model";
import { UserId } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import { makeColombianUser } from "~/core/identity/rules";
import { AgentService, InboundMessage } from "~/shell/agent/agent-service";
import { upsertUser } from "~/shell/identity/repo";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { ApiHarness } from "~/shell/testing/api-harness";
import { HostedInferenceFromLanguageModel } from "~/shell/testing/hosted-inference-fixtures";
import { currentDisclosure } from "./current-disclosure";
import { appendConsentRecord, withSubjectLock } from "./repo";
import { selectTranscriptEntries } from "~/shell/transcript/repo";

// An HTTP caller returns the reply in its response, so it delivers nothing incrementally.
const noDelivery = (): Effect.Effect<void> => Effect.void;

const unconsentedUserId = UserId.make("f1d1a000-0000-4000-8000-0000000008b1");
const concurrentlyRevokedUserId = UserId.make("f1d1a000-0000-4000-8000-0000000008b2");

const MustNotRunModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.die("model must not run before consent"),
    streamText: () => Stream.die("model must not run before consent"),
  })
);

const MustNotRunInference = HostedInferenceFromLanguageModel.pipe(Layer.provide(MustNotRunModel));

const AgentConsentHarness = AgentService.layer.pipe(
  Layer.provideMerge(MustNotRunInference),
  Layer.provideMerge(ApiHarness),
  Layer.provide(TelemetryDisabled)
);

const makeOnboardingGrant = Effect.gen(function* () {
  const occurredAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");
  return ConsentRecord.make({
    id: ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000008b3"),
    subjectUserId: concurrentlyRevokedUserId,
    event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
    disclosure: yield* currentDisclosure,
    evidence: {
      _tag: "ProviderQualifiedMessages",
      disclosureMessage: {
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: "wamid.concurrent-agent-disclosure",
      },
      decisionMessage: {
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: "wamid.concurrent-agent-grant",
      },
    },
    occurredAt,
  });
});

layer(AgentConsentHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "agent consent defense",
  (it) => {
    it.effect("fails before model, transcript, Turn authority, or canonical execution", () =>
      Effect.gen(function* () {
        const user = yield* makeColombianUser(unconsentedUserId, {
          createdAt: DateTime.makeUnsafe("2026-08-01T12:00:00Z"),
          paidTier: "free",
        });
        yield* upsertUser(unconsentedUserId, user);
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM transcript_entries WHERE user_id = ${unconsentedUserId}`;

        const service = yield* AgentService;
        const failure = yield* service
          .handleMessage(
            unconsentedUserId,
            InboundMessage.make({ text: TranscriptText.make("registra este dato privado") }),
            noDelivery
          )
          .pipe(Effect.flip);

        expect(failure._tag).toBe("OnboardingConsentRequired");
        expect(yield* selectTranscriptEntries(unconsentedUserId)).toEqual([]);
      })
    );

    it.effect("lets a winning concurrent revocation stop transcript and model work", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        yield* admin`DELETE FROM hosted_agent_sessions WHERE user_id = ${concurrentlyRevokedUserId}`;
        yield* admin`DELETE FROM consent_records WHERE subject_user_id = ${concurrentlyRevokedUserId}`;
        yield* admin`DELETE FROM transcript_entries WHERE user_id = ${concurrentlyRevokedUserId}`;
        yield* admin`DELETE FROM users WHERE id = ${concurrentlyRevokedUserId}`;
        const occurredAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");
        const user = yield* makeColombianUser(concurrentlyRevokedUserId, {
          createdAt: occurredAt,
          paidTier: "free",
        });
        yield* upsertUser(concurrentlyRevokedUserId, user);
        const grant = yield* makeOnboardingGrant;
        if (grant.evidence._tag !== "ProviderQualifiedMessages") {
          return yield* Effect.die("unexpected onboarding evidence origin");
        }
        const grantEvidence = grant.evidence;
        yield* appendConsentRecord(grant);
        const lockHeld = yield* Deferred.make<void>();
        const commitRevocation = yield* Deferred.make<void>();
        const revocationFiber = yield* withSubjectLock(
          concurrentlyRevokedUserId,
          Effect.gen(function* () {
            yield* appendConsentRecord(
              ConsentRecord.make({
                ...grant,
                id: ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000008b4"),
                event: { _tag: "Revoked", grantId: grant.id },
                evidence: {
                  _tag: "ProviderQualifiedMessages",
                  disclosureMessage: grantEvidence.disclosureMessage,
                  decisionMessage: {
                    ...grantEvidence.decisionMessage,
                    providerMessageId: "wamid.concurrent-agent-revocation",
                  },
                },
                occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:01Z"),
              })
            );
            yield* Deferred.succeed(lockHeld, undefined);
            yield* Deferred.await(commitRevocation);
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(lockHeld);
        const service = yield* AgentService;
        const turnFiber = yield* service
          .handleMessage(
            concurrentlyRevokedUserId,
            InboundMessage.make({ text: TranscriptText.make("registra dato concurrente") }),
            noDelivery
          )
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.succeed(commitRevocation, undefined);
        yield* Fiber.join(revocationFiber);
        const failure = yield* Fiber.join(turnFiber);

        expect(failure._tag).toBe("OnboardingConsentRequired");
        expect(yield* selectTranscriptEntries(concurrentlyRevokedUserId)).toEqual([]);
      })
    );
  }
);
