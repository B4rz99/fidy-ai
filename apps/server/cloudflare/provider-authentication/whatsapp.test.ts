import { whatsappMessages } from "./whatsapp-messages.test-fixture";
import { Clock, Effect, Option, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { recoverPendingDisclosures } from "../consent/ingress/runtime";
import { disposeJourneys, setup, setupWhatsApp } from "./journey.test-fixture";

afterAll(disposeJourneys);
afterEach(() => vi.restoreAllMocks());

const advanceConsentClock = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    const elapsedMilliseconds = 3_100;
    const now = yield* Clock.currentTimeMillis;
    // Cross the same cooldown using the ingress Clock; native D1 and proof checks still execute.
    vi.spyOn(Date, "now").mockReturnValue(now + elapsedMilliseconds);
  });

it("acknowledges uncorrelated sent, delivered and failed receipts without delivery or association effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      const now = yield* Clock.currentTimeMillis;
      let reads = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        reads += 1;
        return Promise.resolve(
          Response.json({
            id: "wamid.review",
            kapso: {
              direction: "outbound",
              phone_number_id: "123456789012345",
              statuses: ["sent", "delivered", "failed"].map((status) => ({
                id: "wamid.review",
                status,
                timestamp: String(Math.floor(now / 1000)),
              })),
            },
          })
        );
      });
      for (const status of ["sent", "delivered", "failed"] as const) {
        expect(
          (yield* whatsappMessages.sendPacket(
            journey,
            {
              phone_number_id: "123456789012345",
              message: { id: "wamid.review", kapso: { direction: "outbound", status } },
            },
            { signature: Option.none(), event: `whatsapp.message.${status}` }
          )).status
        ).toBe(200);
      }
      expect(reads).toBe(3);
      for (const table of ["pending_consent_delivery", "whatsapp_provider_handoffs", "users"]) {
        expect(
          (yield* Effect.tryPromise(() =>
            journey.db.prepare(`SELECT count(*) AS total FROM ${table}`).first<{ total: number }>()
          ))?.total
        ).toBe(0);
      }
    })
  ));

const lifecycleHistory = (fault: string, correlation: string, now: number): Response => {
  const deliveredStatus = fault === "sent_only" ? "sent" : "delivered";
  return Response.json({
    id: fault === "message" ? "wamid.other" : "wamid.disclosure",
    kapso: {
      direction: "outbound",
      phone_number_id: fault === "endpoint" ? "987654321098765" : "123456789012345",
      statuses: [
        {
          id: fault === "status_message" ? "wamid.other" : "wamid.disclosure",
          status: fault === "read_only" ? "read" : deliveredStatus,
          timestamp: String(Math.floor(now / 1000)),
          biz_opaque_callback_data: correlation,
        },
      ],
    },
  });
};

it("bounds signed lifecycle replay, concurrent failures and the shared provider-read budget", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        journey.db.batch([
          journey.db
            .prepare(
              "INSERT INTO resource_admission_events (grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,window_start_epoch_ms,expires_at_epoch_ms) VALUES ('lookup-budget','whatsapp.statusLookup.global.v1','operation','all','rolling_window',499,?,?,?)"
            )
            .bind(now, now, now + 3_600_000),
          journey.db
            .prepare(
              "INSERT INTO resource_admission_grants (id,admitted_at_epoch_ms,claim_count) VALUES ('lookup-budget',?,1)"
            )
            .bind(now),
        ])
      );
      let reads = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        reads += 1;
        return Promise.resolve(new Response(null, { status: 500 }));
      });
      const packet = (id: string): ReturnType<typeof whatsappMessages.sendPacket> =>
        whatsappMessages.sendPacket(
          journey,
          {
            phone_number_id: "123456789012345",
            message: { id, kapso: { direction: "outbound", status: "delivered" } },
          },
          { signature: Option.none(), event: "whatsapp.message.delivered" }
        );
      expect((yield* packet("wamid.replay")).status).toBe(503);
      const concurrent = yield* Effect.all(
        [packet("wamid.replay"), packet("wamid.replay"), packet("wamid.new")],
        { concurrency: "unbounded" }
      );
      expect(concurrent.map((response) => response.status)).toEqual([503, 503, 503]);
      expect(reads).toBe(1);
      expect(
        (yield* whatsappMessages.sendPacket(
          journey,
          {
            phone_number_id: "123456789012345",
            message: { id: "wamid.replay", kapso: { direction: "outbound", status: "sent" } },
          },
          { signature: Option.none(), event: "whatsapp.message.sent" }
        )).status
      ).toBe(503);
      expect(reads).toBe(1);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db
            .prepare("SELECT count(*) AS total FROM pending_consent_delivery")
            .first<{ total: number }>()
        ))?.total
      ).toBe(0);
    })
  ));

it("isolates sandbox receipt lookup to the originating caller and bounds repeated missing receipts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp("123456789012345"));
      const outbound: Array<string> = [];
      const reads: Array<string> = [];
      const now = yield* Clock.currentTimeMillis;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          reads.push(request.url);
          return Promise.resolve(
            lifecycleHistory("sent_only", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", now)
          );
        }
        return request.text().then((body) => {
          outbound.push(body);
          return Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: `wamid.disclosure.${outbound.length}` }],
          });
        });
      });
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", { phone: "573001234567" })).status
      ).toBe(200);
      expect(
        (yield* whatsappMessages.sendChat(journey, "Acepto", {
          caller: "CO.Person2",
          phone: "573009876543",
        })).status
      ).toBe(200);
      expect(reads).toHaveLength(0);
      expect(
        (yield* whatsappMessages.sendChat(journey, "Acepto", { phone: "573001234567" })).status
      ).toBe(409);
      expect(
        (yield* whatsappMessages.sendChat(journey, "Acepto", { phone: "573001234567" })).status
      ).toBe(409);
      expect(reads).toHaveLength(1);
      expect(reads[0]).toContain("/messages/wamid.disclosure.1");
      expect(
        (yield* whatsappMessages.sendChat(journey, "Acepto", {
          caller: "CO.Person2",
          phone: "573009876543",
        })).status
      ).toBe(409);
      expect(reads).toHaveLength(2);
      expect(reads[1]).toContain("/messages/wamid.disclosure.2");
      expect(outbound).toHaveLength(2);
    })
  ));

it.each([
  { fault: "signature", status: 401, reads: 0 },
  { fault: "malformed_history", status: 401, reads: 0 },
  { fault: "endpoint", status: 401, reads: 1 },
  { fault: "message", status: 401, reads: 1 },
  { fault: "status_message", status: 401, reads: 1 },
  { fault: "sent_only", status: 401, reads: 1 },
  { fault: "read_only", status: 401, reads: 1 },
  { fault: "provider_failure", status: 503, reads: 1 },
  { fault: "oversized", status: 503, reads: 1 },
  { fault: "redirect", status: 503, reads: 1 },
])("refuses $fault lifecycle proof without enabling Consent", ({ fault, status, reads }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp());
      let correlation = "";
      let providerReads = 0;
      const outbound: Array<string> = [];
      const now = yield* Clock.currentTimeMillis;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const request = new Request(input, init);
        if (request.method !== "GET") {
          return request.text().then((body) => {
            outbound.push(body);
            return Response.json({
              messaging_product: "whatsapp",
              messages: [{ id: "wamid.disclosure" }],
            });
          });
        }
        providerReads += 1;
        expect(request.redirect).toBe("manual");
        if (fault === "provider_failure") {
          return Promise.resolve(new Response(null, { status: 500 }));
        }
        if (fault === "redirect") {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://untrusted.example/collect" },
            })
          );
        }
        if (fault === "oversized") return Promise.resolve(new Response("x".repeat(65_537)));
        return Promise.resolve(lifecycleHistory(fault, correlation, now));
      });
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", { phone: "573001234567" })).status
      ).toBe(200);
      const sent = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            biz_opaque_callback_data: Schema.String,
          })
        )
      )(outbound[0] ?? "");
      correlation = sent.biz_opaque_callback_data;
      const hint = {
        message: {
          id: "wamid.disclosure",
          kapso: {
            status: "delivered",
            direction: "outbound",
            ...(fault === "malformed_history" ? { statuses: [] } : {}),
          },
        },
        phone_number_id: "123456789012345",
      };
      expect(
        (yield* whatsappMessages.sendPacket(journey, hint, {
          signature: fault === "signature" ? Option.some("0".repeat(64)) : Option.none(),
          event: "whatsapp.message.delivered",
        })).status
      ).toBe(status);
      expect(providerReads).toBe(reads);
      yield* advanceConsentClock();
      const acceptedAt = yield* Clock.currentTimeMillis;
      expect(
        (yield* whatsappMessages.sendChat(journey, "Acepto", {
          timestamp: Math.floor(acceptedAt / 1000) + 299,
          phone: "573001234567",
        })).status
      ).toBe(409);
      expect(outbound).toHaveLength(1);
    })
  )
);

it("cannot open A's Consent decision with B's delivered provider correlation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp("123456789012345"));
      const outbound: Array<string> = [];
      const correlations: Array<string> = [];
      let deliveredAt = yield* Clock.currentTimeMillis;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          const messageId = decodeURIComponent(
            new URL(request.url).pathname.split("/").at(-1) ?? ""
          );
          return Promise.resolve(
            Response.json({
              id: messageId,
              kapso: {
                direction: "outbound",
                phone_number_id: "123456789012345",
                statuses: [
                  {
                    id: messageId,
                    status: "delivered",
                    timestamp: String(Math.floor(deliveredAt / 1000)),
                    biz_opaque_callback_data: correlations[1],
                  },
                ],
              },
            })
          );
        }
        return request.text().then((body) => {
          outbound.push(body);
          const decoded = Schema.decodeOption(
            Schema.fromJsonString(Schema.Struct({ biz_opaque_callback_data: Schema.String }))
          )(body);
          if (Option.isSome(decoded)) correlations.push(decoded.value.biz_opaque_callback_data);
          return Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: `wamid.disclosure.${outbound.length}` }],
          });
        });
      });
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", { phone: "573001234567" })).status
      ).toBe(200);
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", {
          caller: "CO.Person2",
          phone: "573009876543",
        })).status
      ).toBe(200);
      deliveredAt = yield* Clock.currentTimeMillis;
      expect(
        (yield* whatsappMessages.sendChat(journey, "Acepto", { phone: "573001234567" })).status
      ).toBe(409);
      expect(
        (yield* whatsappMessages.sendChat(journey, "Acepto", {
          caller: "CO.Person2",
          phone: "573009876543",
        })).status
      ).toBe(409);
      yield* advanceConsentClock();
      const now = yield* Clock.currentTimeMillis;
      expect(
        (yield* whatsappMessages.sendChat(journey, "Acepto", {
          timestamp: Math.floor(now / 1000) + 299,
          phone: "573001234567",
        })).status
      ).toBe(409);
      expect(
        (yield* whatsappMessages.sendChat(journey, "Acepto", {
          caller: "CO.Person2",
          timestamp: Math.floor(now / 1000) + 299,
          phone: "573009876543",
        })).status
      ).toBe(200);
      expect(outbound).toHaveLength(3);
      expect(outbound[2]).toContain("/auth/google?handoff=");
      expect(outbound[2]).toContain('"to":"573009876543"');
    })
  ));

it.each(["callback", "missing_callback"])(
  "verifies provider delivery history with $0 before accepting native Consent",
  (mode) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const journey = yield* Effect.tryPromise(() => setupWhatsApp("123456789012345"));
        const outbound: Array<string> = [];
        let correlation = "";
        let deliveredAt = yield* Clock.currentTimeMillis;
        vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
          const request = new Request(input, init);
          if (request.method === "GET") {
            expect(request.url).toContain("/123456789012345/messages/wamid.disclosure");
            return Promise.resolve(
              Response.json({
                id: "wamid.disclosure",
                kapso: {
                  direction: "outbound",
                  phone_number_id: "123456789012345",
                  status: "read",
                  statuses: ["sent", "read", "delivered"].map((status) => ({
                    id: "wamid.disclosure",
                    status,
                    timestamp: String(Math.floor(deliveredAt / 1000)),
                    biz_opaque_callback_data: correlation,
                  })),
                },
              })
            );
          }
          return request.text().then((body) => {
            outbound.push(body);
            return Response.json({
              messaging_product: "whatsapp",
              messages: [{ id: "wamid.disclosure" }],
            });
          });
        });
        expect(
          (yield* whatsappMessages.sendChat(journey, "Hola", { phone: "573001234567" })).status
        ).toBe(200);
        const sent = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              biz_opaque_callback_data: Schema.String,
            })
          )
        )(outbound[0] ?? "");
        correlation = sent.biz_opaque_callback_data;
        deliveredAt = yield* Clock.currentTimeMillis;
        const hint = {
          message: {
            id: "wamid.disclosure",
            kapso: { status: "delivered", direction: "outbound" },
          },
          phone_number_id: "123456789012345",
        };
        if (mode === "callback") {
          expect(
            (yield* whatsappMessages.sendPacket(journey, hint, {
              signature: Option.none(),
              event: "whatsapp.message.delivered",
            })).status
          ).toBe(200);
          const replay = yield* Effect.all(
            Array.from({ length: 3 }, () =>
              whatsappMessages.sendPacket(journey, hint, {
                signature: Option.none(),
                event: "whatsapp.message.delivered",
              })
            ),
            { concurrency: "unbounded" }
          );
          expect(replay.map((response) => response.status)).toEqual([503, 503, 503]);
          const receipts = yield* Effect.tryPromise(() =>
            journey.db
              .prepare("SELECT count(*) AS total FROM pending_consent_delivery")
              .first<{ total: number }>()
          );
          expect(receipts?.total).toBe(1);
        }
        expect(
          (yield* whatsappMessages.sendChat(journey, "Acepto", { phone: "573001234567" })).status
        ).toBe(409);
        yield* advanceConsentClock();
        const acceptedAt = yield* Clock.currentTimeMillis;
        expect(
          (yield* whatsappMessages.sendChat(journey, "Acepto", {
            timestamp: Math.floor(acceptedAt / 1000) + 299,
            phone: "573001234567",
          })).status
        ).toBe(200);
        expect(outbound[1]).toContain("/auth/google?handoff=");
      })
    )
);

it("delivers signup disclosure to the provider-observed phone for the configured sandbox endpoint", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp("123456789012345"));
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
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", { phone: "573001234567" })).status
      ).toBe(200);
      const message = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            to: Schema.String,
            text: Schema.Struct({ body: Schema.String }),
            biz_opaque_callback_data: Schema.String,
          })
        )
      )(outbound[0] ?? "");
      expect(message.to).toBe("573001234567");
      expect(message.text.body).toContain("Google o Microsoft");
    })
  ));

it.each([
  { sandbox: "987654321098765", phone: "573001234567", expectedSends: 1 },
  { sandbox: "123456789012345", phone: undefined, expectedSends: 0 },
])(
  "keeps sandbox routing scoped to its business endpoint and refuses missing phone: $sandbox / $phone",
  ({ sandbox, phone, expectedSends }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const journey = yield* Effect.tryPromise(() => setupWhatsApp(sandbox));
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
        expect(
          (yield* whatsappMessages.sendChat(journey, "Hola", phone === undefined ? {} : { phone }))
            .status
        ).toBe(200);
        expect(outbound).toHaveLength(expectedSends);
        if (expectedSends === 1) {
          const body = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ recipient: Schema.String }))
          )(outbound[0] ?? "");
          expect(body.recipient).toBe("CO.Person1");
          expect(outbound[0]).not.toContain('"to"');
        }
      })
    )
);

it("isolates two callers during interrupted sandbox disclosure recovery and never resends a started attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(() => setupWhatsApp("123456789012345"));
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
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", { phone: "573001234567" })).status
      ).toBe(200);
      expect(
        (yield* whatsappMessages.sendChat(journey, "Hola", {
          phone: "573009876543",
          caller: "CO.Person2",
        })).status
      ).toBe(200);
      const prepared = [...outbound];
      yield* Effect.tryPromise(() =>
        journey.db
          .prepare(
            "UPDATE pending_consent_exchanges SET state = 'awaiting_delivery', disclosure_message_id = NULL"
          )
          .run()
      );
      outbound.length = 0;
      yield* recoverPendingDisclosures({
        db: journey.db,
        apiKey: "fixture",
        sandboxPhoneNumberId: Option.some("123456789012345"),
      });
      yield* recoverPendingDisclosures({
        db: journey.db,
        apiKey: "fixture",
        sandboxPhoneNumberId: Option.some("123456789012345"),
      });
      expect(outbound).toHaveLength(2);
      expect(new Set(outbound)).toEqual(new Set(prepared));
      expect(outbound.filter((body) => body.includes('"to":"573001234567"'))).toHaveLength(1);
      expect(outbound.filter((body) => body.includes('"to":"573009876543"'))).toHaveLength(1);
    })
  ));

it("refuses an unknown WhatsApp handoff instead of silently starting web-only signup", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(setup);
      const response = yield* Effect.tryPromise(() => journey.send("/web/providers/disclosure"));
      const disclosure = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ revision: Schema.String })
      )(yield* Effect.tryPromise(() => response.json()));
      const result = yield* Effect.tryPromise(() =>
        journey.send("/web/providers/google/start", {
          ...journey.pairing,
          intent: "signup",
          consentRevision: disclosure.revision,
          handoffReference: "00000000-0000-4000-8000-000000000001",
        })
      );
      expect(result.status).toBe(400);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db.prepare("SELECT id FROM provider_authentication_attempts").all()
        )).results
      ).toEqual([]);
    })
  ));
