import { discloseLegacyChat, disposeLegacyConsent } from "./legacy-disclosure.test-fixture";
import { whatsappMessages } from "./whatsapp-messages.test-fixture";
import { type Cause, Clock, Effect, Option, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { newId } from "../secret-material/operations";
import { disposeJourneys, setupHostedWhatsApp, setupWhatsApp } from "./journey.test-fixture";

afterAll(() => Promise.all([disposeJourneys(), disposeLegacyConsent()]));
afterEach(() => vi.restoreAllMocks());

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
      expect((yield* deliver(rejectedToken, "wamid.rejected")).status).toBe(200);
      const replacementTimestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000) + 1;
      expect(
        (yield* discloseLegacyChat(journey, "Hola", { timestamp: replacementTimestamp })).status
      ).toBe(200);
      const replacementToken = yield* token(outbound[1] ?? "");
      expect(replacementToken).not.toBe(rejectedToken);
      expect((yield* deliver(rejectedToken, "wamid.rejected")).status).toBe(200);
      expect(
        (yield* deliver(replacementToken, "wamid.replacement", replacementTimestamp)).status
      ).toBe(200);
      expect(
        (yield* deliver(replacementToken, "wamid.replacement", replacementTimestamp)).status
      ).toBe(200);
      expect(provider).toHaveBeenCalledTimes(2);
    })
  ));

it.each(["123456789012345", "987654321098765"])(
  "forwards authenticated phone evidence only for the configured sandbox (%s)",
  (sandboxEndpoint) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const forwarded: Array<unknown> = [];
        const userId = newId();
        const journey = yield* Effect.tryPromise(() =>
          setupHostedWhatsApp({
            sandboxPhoneNumberId: sandboxEndpoint,
            userId,
            coordinatorFetch: (request) =>
              request.json().then((body) => {
                forwarded.push(body);
                return new Response(null, { status: 202 });
              }),
          })
        );
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
