import { discloseLegacyChat, disposeLegacyConsent } from "./legacy-disclosure.test-fixture";
import { authenticateChatProvider } from "./whatsapp-provider.test-fixture";
import { whatsappMessages } from "./whatsapp-messages.test-fixture";
import { type Cause, Clock, Effect, Option, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { sweepExpiredConsent } from "../consent/ingress/runtime";
import { newId } from "../secret-material/operations";
import { disposeJourneys, setup, setupHostedWhatsApp, setupWhatsApp } from "./journey.test-fixture";

afterAll(() => Promise.all([disposeJourneys(), disposeLegacyConsent()]));
afterEach(() => vi.restoreAllMocks());

const providerSecondMilliseconds = 1_100;
const consentCooldownMilliseconds = 3_100;

const seedAcceptedChat = (
  db: D1Database
): Effect.Effect<string, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const id = "00000000-0000-4000-8000-000000000002";
    const now = yield* Clock.currentTimeMillis;
    const disclosure = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      currentDisclosureFor()
    );
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            `INSERT INTO pending_consent_exchanges(id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,correlation_token,disclosure_json,disclosure_message_id,created_at_ms,disclosed_at_ms,decision_not_before_ms,expires_at_ms,state) VALUES(?,'portfolio','CO.Person1','123456789012345','first',? ,?,?, 'disclosure',?,?,?,?,'awaiting_decision')`
          )
          .bind(
            id,
            "a".repeat(64),
            id,
            disclosure,
            now - 10000,
            now - 9000,
            now - 8000,
            now - 10000 + 86400000
          ),
        db
          .prepare(
            `UPDATE pending_consent_exchanges SET decision_value=incoming.decision,decision_message_id=incoming.decision_message_id,decision_delivery_key=incoming.delivery_key,decision_body_sha256=incoming.body_sha256,decision_occurred_at_ms=incoming.occurred_at_ms,decision_received_at_ms=incoming.received_at_ms FROM (SELECT ? AS exchange_id,'portfolio' AS portfolio_id,'CO.Person1' AS bsuid,'123456789012345' AS phone_number_id,'accepted' AS decision,? AS disclosure_json,'disclosure' AS disclosure_message_id,'accept' AS decision_message_id,'accept' AS delivery_key,? AS body_sha256,? AS occurred_at_ms,? AS received_at_ms) AS incoming WHERE pending_consent_exchanges.id=incoming.exchange_id AND pending_consent_exchanges.decision_value IS NULL AND pending_consent_exchanges.portfolio_id IS incoming.portfolio_id AND pending_consent_exchanges.bsuid IS incoming.bsuid AND pending_consent_exchanges.phone_number_id IS incoming.phone_number_id AND pending_consent_exchanges.disclosure_json IS incoming.disclosure_json AND pending_consent_exchanges.disclosure_message_id IS incoming.disclosure_message_id`
          )
          .bind(id, disclosure, "a".repeat(64), now - 7000, now - 7000),
        db
          .prepare(
            `INSERT INTO whatsapp_provider_handoffs(id,exchange_id,created_at_ms,expires_at_ms,handoff_send_started_ms) VALUES(?,?,?,?,?)`
          )
          .bind(id, id, now, now + 600000, now),
      ])
    );
    return id;
  });
it("binds an accepted WhatsApp handoff to one browser and refuses a forwarded second-browser claim", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(setup);
      const reference = yield* seedAcceptedChat(journey.db);
      const start = (): Promise<Response> =>
        journey.send("/web/providers/google/start", {
          ...journey.pairing,
          intent: "signup",
          consentRevision: "",
          handoffReference: reference,
        });
      expect((yield* Effect.tryPromise(start)).status).toBe(200);
      const anotherResponse = yield* Effect.tryPromise(() => journey.send("/web/pairings", {}));
      const another = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
      )(yield* Effect.tryPromise(() => anotherResponse.json()));
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/start", {
            ...another,
            intent: "signup",
            consentRevision: "",
            handoffReference: reference,
          })
        )).status
      ).toBe(400);
      expect(
        (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
      ).toEqual([]);
    })
  ));

it("permits a fresh greeting after definite provider rejection without retrying the rejected message", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      const provider = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json(
            { error: "BSUID recipients are not supported in sandbox mode" },
            { status: 403 }
          )
        )
        .mockResolvedValue(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.disclosure" }] })
        );
      const now = yield* Clock.currentTimeMillis;
      const message = "wamid.rejected-greeting";
      const timestamp = Math.floor(now / 1000);
      expect((yield* discloseLegacyChat(journey, "Hola", { message, timestamp })).status).toBe(200);
      expect((yield* discloseLegacyChat(journey, "Hola", { message, timestamp })).status).toBe(409);
      expect(provider).toHaveBeenCalledTimes(1);
      const replacementTimestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000) + 1;
      expect(
        (yield* discloseLegacyChat(journey, "Hola", { timestamp: replacementTimestamp })).status
      ).toBe(200);
      expect(provider).toHaveBeenCalledTimes(2);
    })
  ));

it("refuses late delivery for a rejected disclosure without changing its replacement or repeating egress", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      const outbound: Array<string> = [];
      const provider = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
        new Request(input, init).text().then((body) => {
          outbound.push(body);
          return outbound.length === 1
            ? Response.json(
                { error: "BSUID recipients are not supported in sandbox mode" },
                { status: 403 }
              )
            : Response.json({
                messaging_product: "whatsapp",
                messages: [{ id: "wamid.replacement" }],
              });
        })
      );
      const now = yield* Clock.currentTimeMillis;
      const timestamp = Math.floor(now / 1000) + 1;
      const token = (body: string): Effect.Effect<string, Schema.SchemaError> =>
        Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ biz_opaque_callback_data: Schema.String }))
        )(body).pipe(Effect.map((message) => message.biz_opaque_callback_data));
      const deliver = (
        correlation: string,
        id: string,
        occurredAt = timestamp
      ): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
        whatsappMessages.sendPacket(
          journey,
          {
            message: {
              id,
              kapso: {
                statuses: [
                  {
                    id,
                    status: "delivered",
                    timestamp: String(occurredAt),
                    biz_opaque_callback_data: correlation,
                  },
                ],
              },
            },
            phone_number_id: "123456789012345",
          },
          { signature: Option.none(), event: "whatsapp.message.delivered" }
        );
      expect((yield* discloseLegacyChat(journey, "Hola")).status).toBe(200);
      const rejectedToken = yield* token(outbound[0] ?? "");
      expect((yield* deliver(rejectedToken, "wamid.rejected")).status).toBe(409);
      const replacementTimestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000) + 1;
      expect(
        (yield* discloseLegacyChat(journey, "Hola", { timestamp: replacementTimestamp })).status
      ).toBe(200);
      const replacementToken = yield* token(outbound[1] ?? "");
      expect(replacementToken).not.toBe(rejectedToken);
      expect((yield* deliver(rejectedToken, "wamid.rejected")).status).toBe(409);
      expect(
        (yield* deliver(replacementToken, "wamid.replacement", replacementTimestamp)).status
      ).toBe(200);
      expect(
        (yield* deliver(replacementToken, "wamid.replacement", replacementTimestamp)).status
      ).toBe(200);
      expect(provider).toHaveBeenCalledTimes(2);
    })
  ));

const requestReview = (
  journey: Awaited<ReturnType<typeof setup>>
): Effect.Effect<string, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const status = yield* Effect.tryPromise(() =>
      journey.send("/web/providers/google/status", journey.pairing)
    );
    const review = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        status: Schema.Literal("awaiting_confirmation"),
        associationCode: Schema.String,
      })
    )(yield* Effect.tryPromise(() => status.json()));
    expect((yield* whatsappMessages.sendChat(journey, "Estado")).status).toBe(200);
    return review.associationCode;
  });

it("delivers the immutable association review to the authenticated sandbox phone", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp("123456789012345"));
      const reference = yield* seedAcceptedChat(journey.db);
      yield* authenticateChatProvider(journey, reference);
      const outbound: Array<string> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
        new Request(input, init).text().then((body) => {
          outbound.push(body);
          return Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.association-review" }],
          });
        })
      );
      expect(
        (yield* whatsappMessages.sendChat(journey, "Estado", { phone: "573001234567" })).status
      ).toBe(200);
      const review = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            to: Schema.String,
            text: Schema.Struct({ body: Schema.String }),
          })
        )
      )(outbound[0] ?? "");
      expect(review.to).toBe("573001234567");
      expect(review.text.body).toContain("Confirmo asociación");
    })
  ));
it("requires exact originating caller and reply confirmation, then atomically creates the WhatsApp User and redeems only with private browser proof", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      const reference = yield* seedAcceptedChat(journey.db);
      yield* authenticateChatProvider(journey, reference);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", journey.pairing)
        )).status
      ).toBe(400);
      const status = yield* Effect.tryPromise(() =>
        journey.send("/web/providers/google/status", journey.pairing)
      );
      const review = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          status: Schema.Literal("awaiting_confirmation"),
          associationCode: Schema.String,
        })
      )(yield* Effect.tryPromise(() => status.json()));
      expect((yield* whatsappMessages.sendChat(journey, "Estado")).status).toBe(200);
      const command = `Confirmo asociación ${review.associationCode}`;
      expect(
        (yield* whatsappMessages.sendChat(journey, command, {
          caller: "CO.Person2",
          reply: "wamid.association-review",
        })).status
      ).toBe(409);
      expect(
        (yield* whatsappMessages.sendChat(journey, command, { reply: "different" })).status
      ).toBe(409);
      expect(
        (yield* whatsappMessages.sendChat(journey, command, {
          reply: "wamid.association-review",
          signature: "forged",
        })).status
      ).toBe(401);
      expect(
        (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
      ).toEqual([]);
      const reviewStarted = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ review_started_ms: Schema.Int })
      )(
        yield* Effect.tryPromise(() =>
          journey.db
            .prepare("SELECT review_started_ms FROM whatsapp_provider_handoffs WHERE id=?")
            .bind(reference)
            .first()
        )
      );
      expect(
        (yield* whatsappMessages.sendChat(journey, command, {
          reply: "wamid.association-review",
          timestamp: Math.floor(reviewStarted.review_started_ms / 1000),
        })).status
      ).toBe(409);
      yield* whatsappMessages.advanceClock(providerSecondMilliseconds);
      expect(
        (yield* whatsappMessages.sendChat(journey, command, { reply: "wamid.association-review" }))
          .status
      ).toBe(200);
      expect(
        (yield* whatsappMessages.sendChat(journey, command, { reply: "wamid.association-review" }))
          .status
      ).toBe(409);
      yield* Effect.tryPromise(() =>
        expect(
          journey.db
            .prepare(
              "UPDATE whatsapp_provider_handoffs SET decision_message_id='rewritten-decision' WHERE id=?"
            )
            .bind(reference)
            .run()
        ).rejects.toThrow("whatsapp_handoff_immutable")
      );
      const completed = yield* Effect.tryPromise(() =>
        journey.send("/web/providers/google/complete", journey.pairing)
      );
      expect(completed.status).toBe(200);
      expect(completed.headers.get("set-cookie")).toBeNull();
      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ consumed_at_ms: Schema.Int, completed_at_ms: Schema.Int })
      )(
        yield* Effect.tryPromise(() =>
          journey.db
            .prepare(
              "SELECT h.consumed_at_ms,a.completed_at_ms FROM whatsapp_provider_handoffs h JOIN provider_authentication_attempts a ON a.handoff_id=h.id WHERE h.id=?"
            )
            .bind(reference)
            .first()
        )
      );
      expect(receipt.consumed_at_ms).toBe(receipt.completed_at_ms);

      const created = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ status: Schema.Literal("created"), backupRecoveryCode: Schema.String })
      )(yield* Effect.tryPromise(() => completed.json()));
      expect(created.backupRecoveryCode.length).toBeGreaterThan(20);
      const association = yield* Effect.tryPromise(() =>
        journey.db
          .prepare(
            "SELECT portfolio_id,bsuid FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL)"
          )
          .all()
      );
      expect(association.results).toEqual([{ portfolio_id: "portfolio", bsuid: "CO.Person1" }]);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", journey.pairing)
        )).status
      ).toBe(400);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/pairings/redeem", {
            ...journey.pairing,
            privateVerifier: "b".repeat(43),
          })
        )).status
      ).toBe(400);
      const login = yield* Effect.tryPromise(() =>
        journey.send("/web/pairings/redeem", journey.pairing)
      );
      expect(login.headers.get("set-cookie")).toContain("__Host-fidy_session=");
    })
  ));

it("starts in authenticated WhatsApp with provider instructions and creates no mailbox enrollment", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      const outbound: Array<string> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
        new Request(input, init).text().then((body) => {
          outbound.push(body);
          return Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.disclosure" }],
          });
        })
      );
      expect((yield* discloseLegacyChat(journey, "Hola")).status).toBe(200);
      const message = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          text: Schema.Struct({ body: Schema.String }),
          biz_opaque_callback_data: Schema.String,
        })
      )(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(outbound[0] ?? ""));
      expect(message.text.body).toContain("Google o Microsoft");
      expect(message.text.body).not.toContain("código de verificación");
      const deliveredAt = yield* Clock.currentTimeMillis;
      expect(
        (yield* whatsappMessages.sendPacket(
          journey,
          {
            message: {
              id: "wamid.disclosure",
              kapso: {
                statuses: [
                  {
                    id: "wamid.disclosure",
                    status: "delivered",
                    timestamp: String(Math.floor(deliveredAt / 1000)),
                    biz_opaque_callback_data: message.biz_opaque_callback_data,
                  },
                ],
              },
            },
            phone_number_id: "123456789012345",
          },
          { signature: Option.none(), event: "whatsapp.message.delivered" }
        )).status
      ).toBe(200);
      expect((yield* whatsappMessages.sendChat(journey, "Acepto")).status).toBe(409);
      yield* whatsappMessages.advanceClock(consentCooldownMilliseconds);
      const acceptedAt = yield* Clock.currentTimeMillis;
      expect(
        (yield* whatsappMessages.sendChat(journey, "Acepto", {
          timestamp: Math.floor(acceptedAt / 1000) + 299,
        })).status
      ).toBe(200);
      const handoffText = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ text: Schema.Struct({ body: Schema.String }) })
      )(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(outbound[1] ?? ""));
      expect(handoffText.text.body).toContain("/login?handoff=");
      expect(handoffText.text.body).toContain("Google o Microsoft");
      const reference = /handoff=([0-9a-f-]{36})/u.exec(handoffText.text.body)?.[1] ?? "";
      yield* authenticateChatProvider(journey, reference);
      const review = yield* Effect.tryPromise(() =>
        journey
          .send("/web/providers/google/status", journey.pairing)
          .then((response) => response.json())
          .then(
            Schema.decodeUnknownPromise(
              Schema.Struct({
                status: Schema.Literal("awaiting_association"),
                associationCode: Schema.String,
                confirmationText: Schema.String,
              })
            )
          )
      );
      yield* whatsappMessages.advanceClock(2000);
      expect((yield* whatsappMessages.sendChat(journey, review.confirmationText)).status).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", {
            ...journey.pairing,
            associationCode: review.associationCode,
          })
        )).status
      ).toBe(200);

      expect(
        (yield* Effect.tryPromise(() =>
          journey.db
            .prepare(
              "SELECT user_id FROM (SELECT rowid,user_id,address AS email_address,verified_at_ms FROM verified_email_credentials)"
            )
            .all()
        )).results
      ).toEqual([]);
    })
  ));

it.each(["denied", "expired", "expired_browser", "uncertain_send"] as const)(
  "refuses %s association without stable effects or repeated delivery",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const journey = yield* Effect.tryPromise(() => setupWhatsApp());
        const reference = yield* seedAcceptedChat(journey.db);
        yield* authenticateChatProvider(journey, reference);
        if (scenario === "uncertain_send") {
          const fetch = vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValue(new Error("lost native send response"))
            .mockClear();
          expect((yield* whatsappMessages.sendChat(journey, "Estado")).status).toBe(503);
          expect((yield* whatsappMessages.sendChat(journey, "Estado")).status).toBe(503);
          expect(fetch).toHaveBeenCalledTimes(1);
        } else {
          const code = yield* requestReview(journey);
          yield* whatsappMessages.advanceClock(providerSecondMilliseconds);
          if (scenario === "expired") {
            yield* Effect.tryPromise(() =>
              journey.db
                .prepare("UPDATE whatsapp_provider_handoffs SET expires_at_ms=created_at_ms")
                .run()
            );
          }
          if (scenario === "expired_browser") {
            const pairing = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ expires_at_ms: Schema.Int })
            )(
              yield* Effect.tryPromise(() =>
                journey.db
                  .prepare("SELECT expires_at_ms FROM browser_login_pairings WHERE id=?")
                  .bind(journey.pairing.pairingId)
                  .first()
              )
            );
            yield* whatsappMessages.advanceClock(
              pairing.expires_at_ms - (yield* Clock.currentTimeMillis)
            );
          }
          const command = `${scenario === "denied" ? "Rechazo" : "Confirmo"} asociación ${code}`;
          expect(
            (yield* whatsappMessages.sendChat(journey, command, {
              reply: "wamid.association-review",
            })).status
          ).toBe(scenario === "expired" ? 409 : 200);
          expect(
            (yield* whatsappMessages.sendChat(journey, `Confirmo asociación ${code}`, {
              reply: "wamid.association-review",
            })).status
          ).toBe(409);
        }
        expect(
          (yield* Effect.tryPromise(() =>
            journey.send("/web/providers/google/complete", journey.pairing)
          )).status
        ).toBe(400);
        expect(
          (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
        ).toEqual([]);
      })
    )
);

it.each([
  {
    target: "attempt",
    clause:
      "BEFORE UPDATE OF completed_at_ms ON provider_authentication_attempts WHEN NEW.completed_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture_failure'); END",
  },
  {
    target: "handoff consumption",
    clause:
      "BEFORE UPDATE OF consumed_at_ms ON whatsapp_provider_handoffs WHEN NEW.consumed_at_ms IS NOT NULL BEGIN SELECT RAISE(IGNORE); END",
  },
])(
  "rolls back a failed association commit at $target and permits a successful retry",
  ({ clause }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const journey = yield* Effect.tryPromise(() => setupWhatsApp());
        yield* authenticateChatProvider(journey, yield* seedAcceptedChat(journey.db));
        const code = yield* requestReview(journey);
        yield* whatsappMessages.advanceClock(providerSecondMilliseconds);
        expect(
          (yield* whatsappMessages.sendChat(journey, `Confirmo asociación ${code}`, {
            reply: "wamid.association-review",
          })).status
        ).toBe(200);
        const proofRows = (): Promise<ReadonlyArray<D1Result>> =>
          journey.db.batch([
            journey.db.prepare("SELECT rowid,* FROM whatsapp_provider_handoffs ORDER BY rowid"),
            journey.db.prepare(
              "SELECT rowid,* FROM provider_authentication_attempts ORDER BY rowid"
            ),
          ]);
        const originalProof = yield* Effect.tryPromise(proofRows);
        yield* Effect.tryPromise(() =>
          journey.db.prepare(`CREATE TRIGGER fixture_refuse ${clause}`).run()
        );
        expect(
          (yield* Effect.tryPromise(() =>
            journey.send("/web/providers/google/complete", journey.pairing)
          )).status
        ).toBe(400);
        expect(
          (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
        ).toEqual([]);
        expect(
          (yield* Effect.tryPromise(() =>
            journey.db
              .prepare(
                "SELECT user_id FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL)"
              )
              .all()
          )).results
        ).toEqual([]);
        expect((yield* Effect.tryPromise(proofRows)).map((table) => table.results)).toEqual(
          originalProof.map((table) => table.results)
        );
        yield* Effect.tryPromise(() => journey.db.prepare("DROP TRIGGER fixture_refuse").run());
        expect(
          (yield* Effect.tryPromise(() =>
            journey.send("/web/providers/google/complete", journey.pairing)
          )).status
        ).toBe(200);
        expect(
          (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
        ).toHaveLength(1);
      })
    )
);

it("permits only one concurrent association confirmation and completion", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      yield* authenticateChatProvider(journey, yield* seedAcceptedChat(journey.db));
      const code = yield* requestReview(journey);
      yield* whatsappMessages.advanceClock(providerSecondMilliseconds);
      const confirmations = yield* Effect.all(
        [
          whatsappMessages.sendChat(journey, `Confirmo asociación ${code}`, {
            reply: "wamid.association-review",
          }),
          whatsappMessages.sendChat(journey, `Confirmo asociación ${code}`, {
            reply: "wamid.association-review",
          }),
        ],
        { concurrency: "unbounded" }
      );
      expect(
        confirmations.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([200, 409]);
      const completed = yield* Effect.tryPromise(() =>
        Promise.all([
          journey.send("/web/providers/google/complete", journey.pairing),
          journey.send("/web/providers/google/complete", journey.pairing),
        ])
      );
      expect(
        completed.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([200, 400]);
      expect(
        (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
      ).toHaveLength(1);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", journey.pairing)
        )).status
      ).toBe(400);
    })
  ));

it.each([false, true])(
  "initially links a web-created User while refusing existing association conflicts: %s",
  (conflict) =>
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
          journey.db.prepare("SELECT id,created_at_ms FROM users").all()
        );
        const records = yield* Effect.tryPromise(() =>
          journey.db
            .prepare(
              "SELECT (SELECT COUNT(*) FROM users WHERE trial_started_at_ms IS NOT NULL) trial,(SELECT COUNT(*) FROM backup_recovery_credentials) recovery,(SELECT COUNT(*) FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records) consent"
            )
            .first()
        );
        if (conflict) {
          yield* Effect.tryPromise(() =>
            journey.db
              .prepare(
                "WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (SELECT id,'portfolio','CO.Existing',created_at_ms FROM users) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms"
              )
              .run()
          );
        }
        const pairingResponse = yield* Effect.tryPromise(() => journey.send("/web/pairings", {}));
        const pairing = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
        )(yield* Effect.tryPromise(() => pairingResponse.json()));
        const chatJourney = { ...journey, pairing };
        yield* authenticateChatProvider(chatJourney, yield* seedAcceptedChat(journey.db));
        const code = yield* requestReview(chatJourney);
        yield* whatsappMessages.advanceClock(providerSecondMilliseconds);
        expect(
          (yield* whatsappMessages.sendChat(chatJourney, `Confirmo asociación ${code}`, {
            reply: "wamid.association-review",
          })).status
        ).toBe(200);
        const response = yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", pairing)
        );
        expect(response.status).toBe(conflict ? 400 : 200);
        if (!conflict) {
          expect(yield* Effect.tryPromise(() => response.json())).toEqual({ status: "approved" });
        }
        expect(
          (yield* Effect.tryPromise(() =>
            journey.db.prepare("SELECT id,created_at_ms FROM users").all()
          )).results
        ).toEqual(before.results);
        expect(
          yield* Effect.tryPromise(() =>
            journey.db
              .prepare(
                "SELECT (SELECT COUNT(*) FROM users WHERE trial_started_at_ms IS NOT NULL) trial,(SELECT COUNT(*) FROM backup_recovery_credentials) recovery,(SELECT COUNT(*) FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records) consent"
              )
              .first()
          )
        ).toEqual(records);
      })
    )
);
it("allows an explicit new handoff after expiry without reusing the consumed public reference", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      const reference = yield* seedAcceptedChat(journey.db);
      yield* Effect.tryPromise(() =>
        journey.db
          .prepare("UPDATE whatsapp_provider_handoffs SET expires_at_ms=created_at_ms")
          .run()
      );
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.restart" }] })
        );
      expect((yield* whatsappMessages.sendChat(journey, "Reiniciar")).status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db
            .prepare("SELECT id FROM whatsapp_signup_invitations WHERE id<>?")
            .bind(reference)
            .all()
        )).results
      ).toHaveLength(1);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/start", {
            ...journey.pairing,
            intent: "signup",
            consentRevision: "",
            handoffReference: reference,
          })
        )).status
      ).toBe(400);
    })
  ));

const expireHandoffs = (db: D1Database): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "UPDATE whatsapp_provider_handoffs SET created_at_ms=created_at_ms-1000,expires_at_ms=created_at_ms-1000"
        )
        .run()
    );
    yield* whatsappMessages.advanceClock(600001);
  });

it.each(["source", "spend", "storage"] as const)(
  "refuses native sends when %s admission fails",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const journey = yield* Effect.tryPromise(() => setupWhatsApp());
        yield* seedAcceptedChat(journey.db);
        const fetch = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(() =>
            Promise.resolve(
              Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.budget" }] })
            )
          );
        if (scenario === "source") {
          for (let count = 0; count < 6; count++) {
            yield* expireHandoffs(journey.db);
            expect((yield* whatsappMessages.sendChat(journey, "Reiniciar")).status).toBe(200);
          }
        } else if (scenario === "spend") {
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.tryPromise(() =>
            journey.db.batch([
              journey.db
                .prepare(
                  "INSERT INTO resource_admission_events(grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,window_start_epoch_ms,expires_at_epoch_ms) VALUES('fixture-spend','provider.whatsapp.egress.v1','spend','kapso','rolling_window',1000,?,?,?)"
                )
                .bind(now, now, now + 3600000),
              journey.db
                .prepare(
                  "INSERT INTO resource_admission_grants(id,admitted_at_epoch_ms,claim_count) VALUES('fixture-spend',?,1)"
                )
                .bind(now),
            ])
          );
        } else {
          yield* Effect.tryPromise(() =>
            journey.db
              .prepare(
                "CREATE TRIGGER fixture_admission_failure BEFORE INSERT ON resource_admission_grants BEGIN SELECT RAISE(ABORT,'storage_unavailable'); END"
              )
              .run()
          );
        }
        fetch.mockClear();
        yield* expireHandoffs(journey.db);
        const refused = yield* Effect.all(
          [
            whatsappMessages.sendChat(journey, "Reiniciar"),
            whatsappMessages.sendChat(journey, "Reiniciar"),
          ],
          { concurrency: "unbounded" }
        );
        for (const result of refused) expect([503, 409]).toContain(result.status);
        expect(fetch).not.toHaveBeenCalled();
        expect(
          yield* Effect.tryPromise(() =>
            journey.db
              .prepare(
                "SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL)) associations,(SELECT COUNT(*) FROM web_sessions) sessions"
              )
              .first()
          )
        ).toEqual({ users: 0, associations: 0, sessions: 0 });
      })
    )
);

it("sweeps expired handoff correlation while preserving committed User and legal evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      yield* authenticateChatProvider(journey, yield* seedAcceptedChat(journey.db));
      const code = yield* requestReview(journey);
      yield* whatsappMessages.advanceClock(providerSecondMilliseconds);
      expect(
        (yield* whatsappMessages.sendChat(journey, `Confirmo asociación ${code}`, {
          reply: "wamid.association-review",
        })).status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", journey.pairing)
        )).status
      ).toBe(200);
      const durable =
        "SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM provider_credentials) credentials,(SELECT COUNT(*) FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records) consent,(SELECT COUNT(*) FROM users WHERE trial_started_at_ms IS NOT NULL) trials,(SELECT COUNT(*) FROM backup_recovery_credentials) recovery,(SELECT COUNT(*) FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL)) associations";
      const before = yield* Effect.tryPromise(() => journey.db.prepare(durable).first());
      expect(before).toEqual({
        users: 1,
        credentials: 1,
        consent: 1,
        trials: 1,
        recovery: 1,
        associations: 1,
      });
      yield* Effect.tryPromise(() =>
        journey.db
          .prepare(
            "UPDATE pending_consent_exchanges SET created_at_ms=created_at_ms-172800000,disclosed_at_ms=disclosed_at_ms-172800000,expires_at_ms=expires_at_ms-172800000"
          )
          .run()
      );
      yield* sweepExpiredConsent(journey.db)();
      expect(
        yield* Effect.tryPromise(() =>
          journey.db
            .prepare(
              "SELECT (SELECT COUNT(*) FROM whatsapp_provider_handoffs) handoffs,(SELECT COUNT(*) FROM provider_authentication_attempts) attempts,(SELECT COUNT(*) FROM provider_authentication_attempts WHERE completed_at_ms IS NOT NULL) receipts"
            )
            .first()
        )
      ).toEqual({ handoffs: 0, attempts: 0, receipts: 0 });
      expect(
        (yield* whatsappMessages.sendChat(journey, `Confirmo asociación ${code}`, {
          reply: "wamid.association-review",
        })).status
      ).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", journey.pairing)
        )).status
      ).toBe(400);
      expect(yield* Effect.tryPromise(() => journey.db.prepare(durable).first())).toEqual(before);
    })
  ));

it.each(["123456789012345", "987654321098765"])(
  "forwards authenticated phone evidence only for the configured sandbox (%s)",
  (sandboxEndpoint) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const forwarded: Array<unknown> = [];
        const journey = yield* Effect.tryPromise(() =>
          setupHostedWhatsApp({
            sandboxPhoneNumberId: sandboxEndpoint,
            coordinatorFetch: (request) =>
              request.json().then((body) => {
                forwarded.push(body);
                return new Response(null, { status: 202 });
              }),
          })
        );
        const userId = newId();
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.tryPromise(() =>
          journey.db.batch([
            journey.db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?)"
              )
              .bind(userId, now),
            journey.db
              .prepare(
                "WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (VALUES(?,'portfolio','CO.Person1',?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms"
              )
              .bind(userId, now),
          ])
        );
        expect(
          (yield* whatsappMessages.sendChat(journey, "Hola", { phone: "573001234567" })).status
        ).toBe(202);
        expect(forwarded).toHaveLength(1);
        const proof = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ sandboxPhone: Schema.optionalKey(Schema.String) })
        )(forwarded[0]);
        expect(proof.sandboxPhone).toBe(
          sandboxEndpoint === "123456789012345" ? "+573001234567" : undefined
        );
        expect(forwarded[0]).toMatchObject({
          userId,
          bsuid: "CO.Person1",
        });
        expect(
          (yield* whatsappMessages.sendChat(journey, "Hola", {
            phone: "573009876543",
            signature: "0".repeat(64),
          })).status
        ).toBe(401);
        expect(forwarded).toHaveLength(1);
      })
    )
);
