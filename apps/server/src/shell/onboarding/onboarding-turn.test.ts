import { expect, layer } from "@effect/vitest";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import { Cause, ConfigProvider, DateTime, Effect, Exit, Option, Schema } from "effect";
import { E164PhoneNumber } from "~/core/identity/reference";
import { MigrationSqlClient } from "~/shell/db/client";
import { defaultUserId, defaultWhatsAppPhone } from "~/shell/db/development-seed";
import { resolveWhatsAppCaller } from "~/shell/identity/repo";
import { ApiHarness } from "~/shell/testing/api-harness";
import { deliverConsentDisclosureForTesting } from "~/shell/testing/consent-disclosure";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import { type OnboardingTurn, handleOnboardingTurn } from "./onboarding";

const phone = E164PhoneNumber.make("+573009990001");
const caller = testWhatsAppCaller(phone);
const receivedAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");
const message = (providerMessageId: string): ProviderMessageEvidence => ({
  channel: "whatsapp",
  provider: "kapso",
  providerMessageId,
});
const turn = (text: string, providerMessageId: string, at = receivedAt): OnboardingTurn => ({
  caller,
  content: { _tag: "Text" as const, text },
  message: message(providerMessageId),
  receivedAt: at,
});

const clear = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM email_delivery_admission_budgets`;
      yield* sql`
        DELETE FROM users WHERE id IN (
          SELECT user_id FROM whatsapp_identities
          WHERE business_portfolio_id = ${caller.businessPortfolioId}
            AND business_scoped_user_id = ${caller.businessScopedUserId}
        )
      `;
      yield* sql`
        DELETE FROM email_enrollments
        WHERE business_portfolio_id = ${caller.businessPortfolioId}
          AND business_scoped_user_id = ${caller.businessScopedUserId}
      `;
      yield* sql`
        DELETE FROM pending_consent_exchanges
        WHERE business_portfolio_id = ${caller.businessPortfolioId}
          AND business_scoped_user_id = ${caller.businessScopedUserId}
      `;
    })
  );
});

const acceptDisclosure = Effect.gen(function* () {
  const disclosure = yield* handleOnboardingTurn(turn("Quiero empezar", "wamid.start"));
  expect(disclosure._tag).toBe("SendDisclosure");
  if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
  yield* deliverConsentDisclosureForTesting({
    exchangeId: disclosure.exchangeId,
    message: message("wamid.disclosure"),
    deliveredAt: DateTime.add(receivedAt, { seconds: 1 }),
  });
  return yield* handleOnboardingTurn(
    turn("Acepto", "wamid.accept", DateTime.add(receivedAt, { seconds: 2 }))
  );
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })("consent gate", (it) => {
  it.effect("settles current Consent replays only for their established caller", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ProviderMessageEvidence))(
        yield* sql`
          SELECT decision_channel AS channel, decision_provider AS provider,
            decision_provider_message_id AS "providerMessageId"
          FROM consent_records WHERE subject_user_id = ${defaultUserId}
          ORDER BY occurred_at DESC LIMIT 1
        `
      );
      const replayMessage = rows[0];
      if (replayMessage === undefined) return yield* Effect.die("missing seeded ConsentRecord");
      const establishedCaller = testWhatsAppCaller(defaultWhatsAppPhone);
      const established = yield* handleOnboardingTurn({
        caller: establishedCaller,
        content: { _tag: "Text", text: "Acepto" },
        message: replayMessage,
        receivedAt,
      });
      expect(established).toMatchObject({
        _tag: "Accepted",
        userId: defaultUserId,
      });

      const otherCaller = yield* handleOnboardingTurn({
        ...turn("Acepto", replayMessage.providerMessageId, receivedAt),
        message: replayMessage,
      });
      expect(otherCaller._tag).toBe("ClarifyDecision");
      expect(
        (yield* handleOnboardingTurn({
          caller: establishedCaller,
          content: { _tag: "Text", text: "continúa" },
          message: message("wamid.established-proceed"),
          receivedAt,
        }))._tag
      ).toBe("Proceed");
    })
  );

  it.effect("keeps the email admission HMAC credential out of persistence and outcomes", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* acceptDisclosure;
      const secret = "ab".repeat(32);
      const outcome = yield* handleOnboardingTurn(
        turn(
          "credential-test@example.com",
          "wamid.credential-email",
          DateTime.add(receivedAt, { seconds: 3 })
        )
      ).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            NODE_ENV: "production",
            PUBLIC_WEB_ORIGIN: "https://fidyapp.com",
            PUBLIC_API_ORIGIN: "https://api.fidyapp.com",
            INGEST_EMAIL_DOMAIN: "ingest.fidyapp.com",
            KAPSO_WEBHOOK_SECRET: "test-webhook-secret-32-characters",
            WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio-test",
            EMAIL_ADMISSION_HMAC_KEY: secret,
          })
        )
      );
      expect(outcome._tag).toBe("EmailSubmitted");
      const sql = yield* MigrationSqlClient;
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ scopeKey: Schema.String }))
      )(yield* sql`SELECT scope_key AS "scopeKey" FROM email_delivery_admission_budgets`);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.scopeKey).not.toContain(secret);
      if (outcome._tag === "EmailSubmitted") expect(outcome.status).toBe("sent");
      yield* clear;
    })
  );

  it.effect("rejects weak production email-admission keys before persisting a budget", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* acceptDisclosure;
      const outcome = yield* Effect.exit(
        handleOnboardingTurn(
          turn(
            "weak-key@example.com",
            "wamid.weak-key-email",
            DateTime.add(receivedAt, { seconds: 3 })
          )
        ).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              NODE_ENV: "production",
              EMAIL_ADMISSION_HMAC_KEY: "predictable",
            })
          )
        )
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      if (Exit.isFailure(outcome)) expect(Cause.pretty(outcome.cause)).not.toContain("predictable");
      const sql = yield* MigrationSqlClient;
      const [row] = yield* sql`SELECT count(*)::integer AS count
        FROM email_delivery_admission_budgets`;
      expect(row).toEqual({ count: 0 });
      yield* clear;
    })
  );

  it.effect("commits accepted evidence with one replayable AwaitingEmail enrollment", () =>
    Effect.gen(function* () {
      yield* clear;
      expect((yield* acceptDisclosure)._tag).toBe("AwaitingEmail");
      expect(Option.isNone(yield* resolveWhatsAppCaller(caller))).toBe(true);
      const sql = yield* MigrationSqlClient;
      const beforeReplay = yield* sql`
        SELECT id, public_code AS "publicCode" FROM email_enrollments
        WHERE business_scoped_user_id = ${caller.businessScopedUserId}
      `;
      expect(beforeReplay).toHaveLength(1);

      expect(
        (yield* handleOnboardingTurn(
          turn("Acepto", "wamid.accept", DateTime.add(receivedAt, { seconds: 3 }))
        ))._tag
      ).toBe("AwaitingEmail");
      expect(
        yield* sql`
        SELECT id, public_code AS "publicCode" FROM email_enrollments
        WHERE business_scoped_user_id = ${caller.businessScopedUserId}
      `
      ).toEqual(beforeReplay);
      expect(
        yield* sql`SELECT count(*)::int AS count FROM consent_records
        WHERE decision_provider_message_id = 'wamid.accept'`
      ).toEqual([{ count: 0 }]);
      yield* clear;
    })
  );

  it.effect("normalizes email, rate-limits resends, and immediately replaces addresses", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* acceptDisclosure;
      expect(
        (yield* handleOnboardingTurn(
          turn(
            " Person.Name+Fidy@Example.COM ",
            "wamid.email-one",
            DateTime.add(receivedAt, { seconds: 3 })
          )
        ))._tag
      ).toBe("EmailSubmitted");
      const cooldown = yield* handleOnboardingTurn(
        turn("Reenviar", "wamid.resend-early", DateTime.add(receivedAt, { seconds: 4 }))
      );
      expect(cooldown._tag).toBe("EmailSubmitted");
      if (cooldown._tag === "EmailSubmitted") expect(cooldown.status).toBe("cooldown");

      const replacement = yield* handleOnboardingTurn(
        turn("other@example.com", "wamid.email-two", DateTime.add(receivedAt, { seconds: 5 }))
      );
      expect(replacement._tag).toBe("EmailSubmitted");
      if (replacement._tag === "EmailSubmitted") expect(replacement.status).toBe("sent");
      const sql = yield* MigrationSqlClient;
      expect(
        yield* sql`
        SELECT email_address AS email, delivery_generation AS generation
        FROM email_enrollments WHERE business_scoped_user_id = ${caller.businessScopedUserId}
      `
      ).toEqual([{ email: "other@example.com", generation: 2 }]);
      expect(
        yield* sql`
        SELECT intent.generation, intent.status FROM email_delivery_intents AS intent
        JOIN email_enrollments AS enrollment ON enrollment.id = intent.enrollment_id
        WHERE enrollment.business_scoped_user_id = ${caller.businessScopedUserId}
        ORDER BY intent.generation
      `
      ).toEqual([
        { generation: 1, status: "superseded" },
        { generation: 2, status: "pending" },
      ]);
      yield* clear;
    })
  );

  it.effect("refuses a replacement when shared delivery admission is exhausted", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* acceptDisclosure;
      expect(
        (yield* handleOnboardingTurn(
          turn("first@example.com", "wamid.budget-first", DateTime.add(receivedAt, { seconds: 3 }))
        ))._tag
      ).toBe("EmailSubmitted");
      const sql = yield* MigrationSqlClient;
      yield* sql`
        UPDATE email_delivery_admission_budgets
        SET delivery_count = 5, expires_at = now() + interval '1 hour'
      `;
      expect(
        yield* handleOnboardingTurn(
          turn(
            "second@example.com",
            "wamid.budget-second",
            DateTime.add(receivedAt, { seconds: 4 })
          )
        )
      ).toEqual({ _tag: "EmailSubmitted", status: "quota-reached" });
      yield* clear;
    })
  );

  it.effect("bounds rapid address replacement without applying the explicit-resend cooldown", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* acceptDisclosure;
      const outcomes = [];
      for (let index = 0; index < 6; index += 1) {
        outcomes.push(
          yield* handleOnboardingTurn(
            turn(
              `person${index}@example.com`,
              `wamid.email-${index}`,
              DateTime.add(receivedAt, { seconds: index + 3 })
            )
          )
        );
      }
      expect(outcomes[4]).toMatchObject({ _tag: "EmailSubmitted" });
      expect(outcomes[5]).toEqual({
        _tag: "EmailSubmitted",
        status: "quota-reached",
      });
      expect(
        yield* handleOnboardingTurn(
          turn("Reenviar", "wamid.resend-after-quota", DateTime.add(receivedAt, { seconds: 70 }))
        )
      ).toEqual({ _tag: "EmailSubmitted", status: "quota-reached" });
      const sql = yield* MigrationSqlClient;
      expect(
        yield* sql`
          SELECT email_address AS email, delivery_generation AS generation
          FROM email_enrollments WHERE business_scoped_user_id = ${caller.businessScopedUserId}
        `
      ).toEqual([{ email: "person4@example.com", generation: 5 }]);
      expect(
        yield* sql`
          SELECT count(*)::int AS count FROM email_delivery_intents AS intent
          JOIN email_enrollments AS enrollment ON enrollment.id = intent.enrollment_id
          WHERE enrollment.business_scoped_user_id = ${caller.businessScopedUserId}
        `
      ).toEqual([{ count: 5 }]);
      yield* clear;
    })
  );

  it.effect("keeps email collection bounded and admits resend at the cooldown boundary", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* acceptDisclosure;
      expect(
        (yield* handleOnboardingTurn(
          turn("todavía no", "wamid.email-await", DateTime.add(receivedAt, { seconds: 3 }))
        ))._tag
      ).toBe("AwaitingEmail");
      expect(
        (yield* handleOnboardingTurn({
          ...turn("ignorado", "wamid.email-choice", DateTime.add(receivedAt, { seconds: 3 })),
          content: { _tag: "Choice", choice: "accept" },
        }))._tag
      ).toBe("AwaitingEmail");
      expect(
        (yield* handleOnboardingTurn(
          turn("Reenviar", "wamid.resend-without-email", DateTime.add(receivedAt, { seconds: 4 }))
        ))._tag
      ).toBe("AwaitingEmail");
      yield* handleOnboardingTurn(
        turn("person@example.com", "wamid.email-submit", DateTime.add(receivedAt, { seconds: 5 }))
      );
      expect(
        (yield* handleOnboardingTurn(
          turn("todavía no", "wamid.email-already", DateTime.add(receivedAt, { seconds: 6 }))
        ))._tag
      ).toBe("EmailSubmitted");
      expect(
        (yield* handleOnboardingTurn(
          turn("REENVIAR", "wamid.resend-ready", DateTime.add(receivedAt, { seconds: 65 }))
        ))._tag
      ).toBe("EmailSubmitted");
      const sql = yield* MigrationSqlClient;
      expect(
        yield* sql`
          SELECT delivery_generation AS generation FROM email_enrollments
          WHERE business_scoped_user_id = ${caller.businessScopedUserId}
        `
      ).toEqual([{ generation: 2 }]);
      yield* clear;
    })
  );

  it.effect("keeps undecided and repeated disclosure turns inert", () =>
    Effect.gen(function* () {
      yield* clear;
      const disclosure = yield* handleOnboardingTurn(
        turn("Inicio", "wamid.inert-start", receivedAt)
      );
      if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
      expect(
        (yield* handleOnboardingTurn(
          turn("Acepto", "wamid.before-delivery", DateTime.add(receivedAt, { milliseconds: 1 }))
        ))._tag
      ).toBe("AwaitingDisclosureDelivery");
      yield* deliverConsentDisclosureForTesting({
        exchangeId: disclosure.exchangeId,
        message: message("wamid.inert-disclosure"),
        deliveredAt: DateTime.add(receivedAt, { seconds: 1 }),
      });
      expect(
        (yield* handleOnboardingTurn(
          turn("Acepto", "wamid.inert-start", DateTime.add(receivedAt, { seconds: 2 }))
        ))._tag
      ).toBe("ClarifyDecision");
      expect(
        (yield* handleOnboardingTurn(
          turn("quizás", "wamid.inert-clarify", DateTime.add(receivedAt, { seconds: 3 }))
        ))._tag
      ).toBe("ClarifyDecision");
      expect(
        (yield* handleOnboardingTurn(
          turn("No acepto", "wamid.inert-decline", DateTime.add(receivedAt, { seconds: 4 }))
        ))._tag
      ).toBe("Declined");
      yield* clear;
    })
  );

  it.effect("replaces stale and expired pending disclosure state", () =>
    Effect.gen(function* () {
      yield* clear;
      expect(
        (yield* handleOnboardingTurn(turn("Inicio", "wamid.stale-start", receivedAt)))._tag
      ).toBe("SendDisclosure");
      const sql = yield* MigrationSqlClient;
      yield* sql`
        UPDATE pending_consent_exchanges SET disclosure_revision = 'stale-revision'
        WHERE business_scoped_user_id = ${caller.businessScopedUserId}
      `;
      expect(
        (yield* handleOnboardingTurn(
          turn("Inicio", "wamid.stale-replaced", DateTime.add(receivedAt, { seconds: 1 }))
        ))._tag
      ).toBe("SendDisclosure");
      yield* sql`
        UPDATE pending_consent_exchanges
        SET created_at = created_at - interval '25 hours',
            expires_at = expires_at - interval '25 hours'
        WHERE business_scoped_user_id = ${caller.businessScopedUserId}
      `;
      expect(
        (yield* handleOnboardingTurn(
          turn("Inicio", "wamid.expired-replaced", DateTime.add(receivedAt, { seconds: 2 }))
        ))._tag
      ).toBe("SendDisclosure");
      yield* clear;
    })
  );

  it.effect("deletes all bounded pre-User evidence on cancellation and expiry", () =>
    Effect.gen(function* () {
      yield* clear;
      yield* acceptDisclosure;
      expect(
        (yield* handleOnboardingTurn(
          turn("Cancelar", "wamid.cancel", DateTime.add(receivedAt, { seconds: 3 }))
        ))._tag
      ).toBe("Declined");
      const sql = yield* MigrationSqlClient;
      expect(
        yield* sql`
        SELECT count(*)::int AS count FROM email_enrollments
        WHERE business_scoped_user_id = ${caller.businessScopedUserId}
      `
      ).toEqual([{ count: 0 }]);
      expect(
        yield* sql`
        SELECT count(*)::int AS count FROM pending_consent_exchanges
        WHERE business_scoped_user_id = ${caller.businessScopedUserId}
      `
      ).toEqual([{ count: 0 }]);

      yield* acceptDisclosure;
      expect(
        (yield* handleOnboardingTurn(
          turn(
            "user@example.com",
            "wamid.expired",
            DateTime.add(receivedAt, { hours: 24, seconds: 2 })
          )
        ))._tag
      ).toBe("Declined");
      expect(
        yield* sql`
        SELECT count(*)::int AS count FROM email_enrollments
        WHERE business_scoped_user_id = ${caller.businessScopedUserId}
      `
      ).toEqual([{ count: 0 }]);
      yield* clear;
    })
  );

  it.effect("refuses a decision that predates delivered disclosure", () =>
    Effect.gen(function* () {
      yield* clear;
      const disclosure = yield* handleOnboardingTurn(turn("Inicio", "wamid.order-start"));
      if (disclosure._tag !== "SendDisclosure") return;
      yield* deliverConsentDisclosureForTesting({
        exchangeId: disclosure.exchangeId,
        message: message("wamid.order-disclosure"),
        deliveredAt: DateTime.add(receivedAt, { seconds: 2 }),
      });
      expect(
        (yield* handleOnboardingTurn(
          turn("Acepto", "wamid.order-accept", DateTime.add(receivedAt, { seconds: 1 }))
        ))._tag
      ).toBe("ClarifyDecision");
      const sql = yield* MigrationSqlClient;
      expect(
        yield* sql`
        SELECT count(*)::int AS count FROM email_enrollments
        WHERE business_scoped_user_id = ${caller.businessScopedUserId}
      `
      ).toEqual([{ count: 0 }]);
      yield* clear;
    })
  );
});
