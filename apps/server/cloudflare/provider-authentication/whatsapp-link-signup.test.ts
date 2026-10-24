import { makeProviderAuthenticationErasureStores, sweepProviderAuthentication } from "./runtime";
import { authenticateChatProvider } from "./whatsapp-provider.test-fixture";
import { Clock, Effect, Option, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { disposeJourneys, setupWhatsApp } from "./journey.test-fixture";
import { whatsappMessages } from "./whatsapp-messages.test-fixture";

afterAll(disposeJourneys);
afterEach(() => vi.restoreAllMocks());

it("offers one signup link without treating the first WhatsApp message as Consent or identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      const outbound: Array<string> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
        new Request(input, init).text().then((body) => {
          outbound.push(body);
          return Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.signup-link" }],
          });
        })
      );
      const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", {
          message: "wamid.signup-start",
          timestamp,
        })).status
      ).toBe(200);
      expect(outbound).toHaveLength(1);
      expect(outbound[0]).toContain("/login?handoff=");
      expect(outbound[0]).not.toContain("Responde");
      expect(
        (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db
            .prepare("SELECT id FROM consent_history WHERE record_type='processing_grant'")
            .all()
        )).results
      ).toEqual([]);
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", {
          message: "wamid.signup-start",
          timestamp,
        })).status
      ).toBe(200);
      expect(outbound).toHaveLength(1);
    })
  ));

it("requires browser Consent before binding a signup invitation to one private provider attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({
          messaging_product: "whatsapp",
          messages: [{ id: "wamid.signup-link" }],
        })
      );
      expect((yield* whatsappMessages.sendChat(journey, "Hola")).status).toBe(200);
      const invitation = yield* Effect.tryPromise(() =>
        journey.db.prepare("SELECT id FROM whatsapp_signup_invitations").first<{ id: string }>()
      );
      expect(invitation).not.toBeNull();
      const request = { ...journey.pairing, intent: "signup", handoffReference: invitation?.id };
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/start", {
            ...request,
            consentRevision: "",
          })
        )).status
      ).toBe(400);
      const disclosure = yield* Effect.tryPromise(() =>
        journey
          .send("/web/providers/disclosure")
          .then((response) => response.json())
          .then(Schema.decodeUnknownPromise(Schema.Struct({ revision: Schema.String })))
      );
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/start", {
            ...request,
            consentRevision: disclosure.revision,
          })
        )).status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
      ).toEqual([]);
    })
  ));

it("links only after the original chat sends its prepared provider-account confirmation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({
          messaging_product: "whatsapp",
          messages: [{ id: "wamid.signup-link" }],
        })
      );
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", { phone: "573001234567" })).status
      ).toBe(200);
      const invitation = yield* Effect.tryPromise(() =>
        journey.db.prepare("SELECT id FROM whatsapp_signup_invitations").first<{ id: string }>()
      );
      yield* authenticateChatProvider(journey, invitation?.id ?? "");
      const response = yield* Effect.tryPromise(() =>
        journey.send("/web/providers/google/status", journey.pairing)
      );
      const review = yield* Effect.tryPromise(() =>
        response.json().then(
          Schema.decodeUnknownPromise(
            Schema.Struct({
              status: Schema.String,
              associationCode: Schema.String,
              confirmationText: Schema.String,
              accountLabel: Schema.String,
              whatsappPhone: Schema.NullOr(Schema.String),
            })
          )
        )
      );
      expect(review.status).toBe("awaiting_association");
      expect(review.accountLabel).toBe("person@example.test");
      expect(review.whatsappPhone).toBe("+573001234567");
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", journey.pairing)
        )).status
      ).toBe(400);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", {
            ...journey.pairing,
            associationCode: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          })
        )).status
      ).toBe(400);
      yield* whatsappMessages.advanceClock(2000);
      expect((yield* whatsappMessages.sendChat(journey, review.confirmationText)).status).toBe(200);
      const completed = yield* Effect.tryPromise(() =>
        journey.send("/web/providers/google/complete", {
          ...journey.pairing,
          associationCode: review.associationCode,
        })
      );
      expect(completed.status).toBe(200);
      const result = yield* Effect.tryPromise(() =>
        completed
          .json()
          .then(
            Schema.decodeUnknownPromise(
              Schema.Struct({ status: Schema.String, whatsappReturnUrl: Schema.String })
            )
          )
      );
      expect(result.status).toBe("created");
      expect(result.whatsappReturnUrl).toBe("https://wa.me/12056871742");
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db.prepare("SELECT whatsapp_portfolio_id,whatsapp_bsuid FROM users").all()
        )).results
      ).toEqual([{ whatsapp_portfolio_id: "portfolio", whatsapp_bsuid: "CO.Person1" }]);
      expect(
        (yield* Effect.tryPromise(() => journey.send("/web/pairings/redeem", journey.pairing)))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", {
            ...journey.pairing,
            associationCode: review.associationCode,
          })
        )).status
      ).toBe(400);
    })
  ));

const reviewedInvitation = Effect.fn(function* (confirm: boolean = true) {
  const journey = yield* Effect.tryPromise(() => setupWhatsApp());
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.invitation" }] })
  );
  expect(
    (yield* whatsappMessages.sendChat(journey, "Hola", { phone: "573001234567" })).status
  ).toBe(200);
  const invitation = yield* Effect.tryPromise(() =>
    journey.db.prepare("SELECT id FROM whatsapp_signup_invitations").first<{ id: string }>()
  );
  yield* authenticateChatProvider(journey, invitation?.id ?? "");
  const review = yield* Effect.tryPromise(() =>
    journey
      .send("/web/providers/google/status", journey.pairing)
      .then((response) => response.json())
      .then(
        Schema.decodeUnknownPromise(
          Schema.Struct({ associationCode: Schema.String, confirmationText: Schema.String })
        )
      )
  );
  if (confirm) {
    yield* whatsappMessages.advanceClock(2000);
    expect((yield* whatsappMessages.sendChat(journey, review.confirmationText)).status).toBe(200);
  }
  return {
    journey,
    reference: invitation?.id ?? "",
    proof: { ...journey.pairing, associationCode: review.associationCode },
    confirmationText: review.confirmationText,
  };
});

it.each(["foreign browser", "wrong provider", "expired"])(
  "refuses %s invitation completion without partial onboarding",
  (fault) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { journey, proof } = yield* reviewedInvitation();
        const before = yield* Effect.tryPromise(() =>
          journey.db
            .prepare(
              "SELECT pairing_id,approved_at_ms,consumed_at_ms FROM whatsapp_signup_invitations"
            )
            .all()
        );
        let submitted = proof;
        if (fault === "foreign browser") submitted = { ...proof, privateVerifier: "a".repeat(43) };
        if (fault === "expired") yield* whatsappMessages.advanceClock(600001);
        expect(
          (yield* Effect.tryPromise(() =>
            journey.send(
              `/web/providers/${fault === "wrong provider" ? "microsoft" : "google"}/complete`,
              submitted
            )
          )).status
        ).toBe(400);
        expect(
          (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
        ).toEqual([]);
        expect(
          (yield* Effect.tryPromise(() =>
            journey.db.prepare("SELECT user_id FROM provider_credentials").all()
          )).results
        ).toEqual([]);
        expect(
          (yield* Effect.tryPromise(() =>
            journey.db
              .prepare("SELECT id FROM consent_history WHERE record_type='processing_grant'")
              .all()
          )).results
        ).toEqual([]);
        expect(
          (yield* Effect.tryPromise(() =>
            journey.db
              .prepare(
                "SELECT pairing_id,approved_at_ms,consumed_at_ms FROM whatsapp_signup_invitations"
              )
              .all()
          )).results
        ).toEqual(before.results);
      })
    )
);

it("refuses a first claimant of a forwarded invitation without originating-chat approval", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      // This pairing is the first browser to claim the public reference, not a later impostor.
      const { journey, proof } = yield* reviewedInvitation(false);
      expect(
        (yield* Effect.tryPromise(() => journey.send("/web/providers/google/complete", proof)))
          .status
      ).toBe(400);
      expect(
        (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db.prepare("SELECT user_id FROM provider_credentials").all()
        )).results
      ).toEqual([]);
    })
  ));

it.each([
  "foreign caller",
  "foreign endpoint",
  "altered account",
  "pre-review message",
  "bad signature",
  "denied",
  "replaced attempt",
])("does not link after %s confirmation", (fault) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { journey, proof, reference, confirmationText } = yield* reviewedInvitation(false);
      const queuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000) - 1;
      yield* whatsappMessages.advanceClock(2000);
      if (fault === "replaced attempt") {
        yield* authenticateChatProvider(journey, reference);
        expect(
          (yield* Effect.tryPromise(() =>
            journey.send("/web/providers/google/status", journey.pairing)
          )).status
        ).toBe(200);
      }
      let text = confirmationText;
      if (fault === "altered account") {
        text = confirmationText.replace("person@example.test", "attacker@example.test");
      }
      if (fault === "denied") text = confirmationText.replace(/^Vincular /u, "No vincular ");
      const reply =
        fault === "foreign endpoint"
          ? yield* whatsappMessages.sendPacket(
              journey,
              {
                message: {
                  id: "wamid.wrong-endpoint",
                  timestamp: String(Math.floor((yield* Clock.currentTimeMillis) / 1000)),
                  type: "text",
                  from_user_id: "CO.Person1",
                  text: { body: text },
                },
                conversation: { business_scoped_user_id: "CO.Person1" },
                phone_number_id: "999999999999999",
              },
              { signature: Option.none(), event: "whatsapp.message.received" }
            )
          : yield* whatsappMessages.sendChat(journey, text, {
              ...(fault === "foreign caller" ? { caller: "CO.Attacker" } : {}),
              ...(fault === "pre-review message" ? { timestamp: queuedAt } : {}),
              ...(fault === "bad signature" ? { signature: "invalid" } : {}),
            });
      expect(reply.status).not.toBe(503);
      expect(
        (yield* Effect.tryPromise(() => journey.send("/web/providers/google/complete", proof)))
          .status
      ).toBe(400);
      expect(
        (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
      ).toEqual([]);
    })
  )
);

it("refuses a second private browser claiming an already bound invitation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { journey, reference } = yield* reviewedInvitation();
      const another = yield* Effect.tryPromise(() =>
        journey
          .send("/web/pairings", {})
          .then((response) => response.json())
          .then(
            Schema.decodeUnknownPromise(
              Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
            )
          )
      );
      const disclosure = yield* Effect.tryPromise(() =>
        journey
          .send("/web/providers/disclosure")
          .then((response) => response.json())
          .then(Schema.decodeUnknownPromise(Schema.Struct({ revision: Schema.String })))
      );
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/start", {
            ...another,
            intent: "signup",
            consentRevision: disclosure.revision,
            handoffReference: reference,
          })
        )).status
      ).toBe(400);
      expect(
        (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
      ).toEqual([]);
    })
  ));

it.each(["approval", "association", "completion", "consumption"])(
  "rolls back the entire signup if %s cannot commit",
  (fault) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { journey, proof } = yield* reviewedInvitation();
        const refusal = {
          approval:
            "BEFORE UPDATE OF approved_at_ms ON whatsapp_signup_invitations WHEN NEW.approved_at_ms IS NOT NULL",
          association:
            "BEFORE UPDATE OF whatsapp_bsuid ON users WHEN NEW.whatsapp_bsuid IS NOT NULL",
          completion:
            "BEFORE UPDATE OF completed_at_ms ON provider_authentication_attempts WHEN NEW.completed_at_ms IS NOT NULL",
          consumption:
            "BEFORE UPDATE OF consumed_at_ms ON whatsapp_signup_invitations WHEN NEW.consumed_at_ms IS NOT NULL",
        }[fault];
        yield* Effect.tryPromise(() =>
          journey.db
            .prepare(`CREATE TRIGGER fixture_refusal ${refusal} BEGIN SELECT RAISE(IGNORE); END`)
            .run()
        );
        expect(
          (yield* Effect.tryPromise(() => journey.send("/web/providers/google/complete", proof)))
            .status
        ).toBe(400);
        for (const table of [
          "users",
          "provider_credentials",
          "backup_recovery_credentials",
          "(SELECT id FROM consent_history WHERE record_type='processing_grant')",
        ]) {
          expect(
            (yield* Effect.tryPromise(() =>
              journey.db
                .prepare(`SELECT count(*) AS total FROM ${table}`)
                .first<{ total: number }>()
            ))?.total
          ).toBe(0);
        }
        expect(
          yield* Effect.tryPromise(() =>
            journey.db
              .prepare("SELECT approved_at_ms,consumed_at_ms FROM whatsapp_signup_invitations")
              .first()
          )
        ).toEqual({ approved_at_ms: null, consumed_at_ms: null });
      })
    )
);

it("links an existing provider User without replacing Consent, TrialPeriod or recovery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      yield* authenticateChatProvider(journey, "");
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", journey.pairing)
        )).status
      ).toBe(200);
      const before = yield* Effect.tryPromise(() =>
        journey.db.prepare("SELECT id,trial_started_at_ms FROM users").all()
      );
      const recovery = yield* Effect.tryPromise(() =>
        journey.db
          .prepare("SELECT user_id,created_at_ms,code_digest FROM backup_recovery_credentials")
          .all()
      );
      const consent = yield* Effect.tryPromise(() =>
        journey.db
          .prepare("SELECT * FROM consent_history WHERE record_type='processing_grant'")
          .all()
      );
      const pairing = yield* Effect.tryPromise(() =>
        journey
          .send("/web/pairings", {})
          .then((response) => response.json())
          .then(
            Schema.decodeUnknownPromise(
              Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
            )
          )
      );
      const next = { ...journey, pairing };
      expect(
        (yield* whatsappMessages.sendChat(next, "Hola", { phone: "573001234567" })).status
      ).toBe(200);
      const invitation = yield* Effect.tryPromise(() =>
        journey.db.prepare("SELECT id FROM whatsapp_signup_invitations").first<{ id: string }>()
      );
      yield* authenticateChatProvider(next, invitation?.id ?? "");
      const review = yield* Effect.tryPromise(() =>
        next
          .send("/web/providers/google/status", pairing)
          .then((response) => response.json())
          .then(
            Schema.decodeUnknownPromise(
              Schema.Struct({ associationCode: Schema.String, confirmationText: Schema.String })
            )
          )
      );
      yield* whatsappMessages.advanceClock(2000);
      expect((yield* whatsappMessages.sendChat(next, review.confirmationText)).status).toBe(200);
      const response = yield* Effect.tryPromise(() =>
        next.send("/web/providers/google/complete", {
          ...pairing,
          associationCode: review.associationCode,
        })
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({
        status: "approved",
        whatsappReturnUrl: "https://wa.me/12056871742",
      });
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db.prepare("SELECT id,trial_started_at_ms FROM users").all()
        )).results
      ).toEqual(before.results);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db
            .prepare("SELECT user_id,created_at_ms,code_digest FROM backup_recovery_credentials")
            .all()
        )).results
      ).toEqual(recovery.results);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db
            .prepare("SELECT * FROM consent_history WHERE record_type='processing_grant'")
            .all()
        )).results
      ).toEqual(consent.results);
      expect(
        (yield* Effect.tryPromise(() => next.send("/web/pairings/redeem", pairing))).status
      ).toBe(200);
    })
  ));

it("allows only one completion under concurrent approval", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { journey, proof } = yield* reviewedInvitation();
      const responses = yield* Effect.all(
        [
          Effect.tryPromise(() => journey.send("/web/providers/google/complete", proof)),
          Effect.tryPromise(() => journey.send("/web/providers/google/complete", proof)),
        ],
        { concurrency: "unbounded" }
      );
      expect(
        responses.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([200, 400]);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db.prepare("SELECT count(*) AS total FROM users").first<{ total: number }>()
        ))?.total
      ).toBe(1);
    })
  ));

it("invalidates the prior review when the same private browser retries provider authentication", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { journey, reference, proof, confirmationText } = yield* reviewedInvitation(false);
      yield* authenticateChatProvider(journey, reference);
      const review = yield* Effect.tryPromise(() =>
        journey
          .send("/web/providers/google/status", journey.pairing)
          .then((response) => response.json())
          .then(
            Schema.decodeUnknownPromise(
              Schema.Struct({
                status: Schema.String,
                associationCode: Schema.String,
                confirmationText: Schema.String,
              })
            )
          )
      );
      expect(review.status).toBe("awaiting_association");
      expect(review.associationCode).not.toBe(proof.associationCode);
      yield* whatsappMessages.advanceClock(2000);
      expect((yield* whatsappMessages.sendChat(journey, confirmationText)).status).toBe(409);
      expect((yield* whatsappMessages.sendChat(journey, review.confirmationText)).status).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", {
            ...journey.pairing,
            associationCode: review.associationCode,
          })
        )).status
      ).toBe(200);
    })
  ));

it("does not replace an established WhatsAppIdentity when a different chat requests linking", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { journey, proof } = yield* reviewedInvitation();
      expect(
        (yield* Effect.tryPromise(() => journey.send("/web/providers/google/complete", proof)))
          .status
      ).toBe(200);
      const before = yield* Effect.tryPromise(() =>
        journey.db.prepare("SELECT * FROM users").all()
      );
      const pairing = yield* Effect.tryPromise(() =>
        journey
          .send("/web/pairings", {})
          .then((response) => response.json())
          .then(
            Schema.decodeUnknownPromise(
              Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
            )
          )
      );
      const next = { ...journey, pairing };
      expect(
        (yield* whatsappMessages.sendChat(next, "Hola", {
          caller: "CO.Person2",
          phone: "573009876543",
        })).status
      ).toBe(200);
      const invitation = yield* Effect.tryPromise(() =>
        journey.db
          .prepare("SELECT id FROM whatsapp_signup_invitations WHERE source_bsuid='CO.Person2'")
          .first<{ id: string }>()
      );
      yield* authenticateChatProvider(next, invitation?.id ?? "");
      const review = yield* Effect.tryPromise(() =>
        next
          .send("/web/providers/google/status", pairing)
          .then((response) => response.json())
          .then(
            Schema.decodeUnknownPromise(
              Schema.Struct({ associationCode: Schema.String, confirmationText: Schema.String })
            )
          )
      );
      yield* whatsappMessages.advanceClock(2000);
      expect(
        (yield* whatsappMessages.sendChat(next, review.confirmationText, {
          caller: "CO.Person2",
          phone: "573009876543",
        })).status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          next.send("/web/providers/google/complete", {
            ...pairing,
            associationCode: review.associationCode,
          })
        )).status
      ).toBe(400);
      expect(
        (yield* Effect.tryPromise(() => journey.db.prepare("SELECT * FROM users").all())).results
      ).toEqual(before.results);
      expect(
        yield* Effect.tryPromise(() =>
          journey.db
            .prepare(
              "SELECT decision,approved_at_ms,consumed_at_ms FROM whatsapp_signup_invitations WHERE source_bsuid='CO.Person2'"
            )
            .first()
        )
      ).toEqual({ decision: "confirmed", approved_at_ms: null, consumed_at_ms: null });
    })
  ));

it("retains an ambiguous send claim until expiry without repeating delivery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      const provider = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("uncertain transport"))
        .mockResolvedValue(
          Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.next-invitation" }],
          })
        );
      expect((yield* whatsappMessages.sendChat(journey, "Hola")).status).toBe(503);
      expect((yield* whatsappMessages.sendChat(journey, "Hola")).status).toBe(200);
      expect(provider).toHaveBeenCalledTimes(1);
      yield* whatsappMessages.advanceClock(600001);
      expect((yield* whatsappMessages.sendChat(journey, "Hola")).status).toBe(200);
      expect(provider).toHaveBeenCalledTimes(2);
      expect(
        (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
      ).toEqual([]);
    })
  ));

it("sweeps only invitations past their one-day retention cutoff", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.retention" }] })
        )
      );
      expect((yield* whatsappMessages.sendChat(journey, "Hola")).status).toBe(200);
      const expired = yield* Effect.tryPromise(() =>
        journey.db
          .prepare("SELECT expires_at_ms FROM whatsapp_signup_invitations")
          .first()
          .then(Schema.decodeUnknownPromise(Schema.Struct({ expires_at_ms: Schema.Int })))
      );
      yield* whatsappMessages.advanceClock(660000);
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", { caller: "CO.Person2" })).status
      ).toBe(200);
      yield* sweepProviderAuthentication({
        db: journey.db,
        current: expired.expires_at_ms + 86400000 + 1,
      });
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db.prepare("SELECT source_bsuid FROM whatsapp_signup_invitations").all()
        )).results
      ).toEqual([{ source_bsuid: "CO.Person2" }]);
    })
  ));

it("erases only the associated User's invitation through its credential owner and fences unpermitted deletion", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { journey, proof } = yield* reviewedInvitation();
      expect(
        (yield* Effect.tryPromise(() => journey.send("/web/providers/google/complete", proof)))
          .status
      ).toBe(200);
      const user = yield* Effect.tryPromise(() =>
        journey.db
          .prepare("SELECT id FROM users")
          .first()
          .then(Schema.decodeUnknownPromise(Schema.Struct({ id: Schema.String })))
      );
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", { caller: "CO.Person2" })).status
      ).toBe(200);
      const reference = "15310000-0000-4000-8000-000000000002";
      yield* Effect.tryPromise(() =>
        journey.db.batch([
          journey.db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,1,'Draining')"
            )
            .bind(reference, user.id),
          ...["provider_authentication_attempts", "whatsapp_signup_invitations"].map((store) =>
            journey.db
              .prepare("INSERT INTO erasure_steps(request_id,store_id) VALUES(?,?)")
              .bind(reference, store)
          ),
          journey.db
            .prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?")
            .bind(reference),
        ])
      );
      yield* Effect.tryPromise(() =>
        expect(
          journey.db
            .prepare("DELETE FROM whatsapp_signup_invitations WHERE pairing_id=?")
            .bind(proof.pairingId)
            .run()
        ).rejects.toThrow("erasure_fenced")
      );
      const stores = makeProviderAuthenticationErasureStores(journey.db);
      for (const id of ["provider_authentication_attempts", "whatsapp_signup_invitations"]) {
        const store = stores.find((item) => item.id === id);
        if (store === undefined) throw Error("Missing invitation erasure owner");
        expect(
          (yield* Effect.result(
            store.remove({ reference, userId: "15310000-0000-4000-8000-000000000099" })
          ))._tag
        ).toBe("Failure");
        expect(yield* store.remove({ reference, userId: user.id })).toBe(true);
      }
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db.prepare("SELECT source_bsuid FROM whatsapp_signup_invitations").all()
        )).results
      ).toEqual([{ source_bsuid: "CO.Person2" }]);
    })
  ));
