import { sweepExpiredConsent } from "../consent/ingress/runtime";
import { newId } from "../secret-material/operations";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { type Cause, Clock, Effect, Option, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { disposeJourneys, setup, setupWhatsApp } from "./journey.test-fixture";

afterAll(disposeJourneys);
afterEach(() => vi.restoreAllMocks());

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
            `INSERT INTO pending_consent_decisions(exchange_id,portfolio_id,bsuid,phone_number_id,decision,disclosure_json,disclosure_message_id,decision_message_id,delivery_key,body_sha256,occurred_at_ms,received_at_ms) VALUES(?,'portfolio','CO.Person1','123456789012345','accepted',?,'disclosure','accept','accept',?,?,?)`
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

const sendPacket = (
  journey: Awaited<ReturnType<typeof setup>>,
  body: unknown,
  options: Readonly<{ signature: Option.Option<string>; event: string }>
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)
    );
    const key = yield* Effect.tryPromise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("test-kapso-secret"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
    );
    const signed = yield* Effect.tryPromise(() => crypto.subtle.sign("HMAC", key, bytes));
    const signature = Array.from(new Uint8Array(signed), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    return yield* Effect.tryPromise(() =>
      journey.send("/providers/kapso/callback", body, {
        "x-webhook-signature": Option.getOrElse(options.signature, () => signature),
        "x-webhook-event": options.event,
        "x-idempotency-key": "delivery",
      })
    );
  });
const sendChat = (
  journey: Awaited<ReturnType<typeof setup>>,
  text: string,
  options: Partial<
    Readonly<{
      caller: string;
      reply: string;
      signature: string;
      message: string;
      timestamp: number;
    }>
  > = {}
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const messageId = newId();
    const body = {
      message: {
        id: options.message ?? messageId,
        timestamp: String(options.timestamp ?? Math.floor(now / 1000)),
        type: "text",
        from_user_id: options.caller ?? "CO.Person1",
        text: { body: text },
        ...(options.reply === undefined ? {} : { context: { id: options.reply } }),
      },
      conversation: { business_scoped_user_id: options.caller ?? "CO.Person1" },
      phone_number_id: "123456789012345",
    };
    return yield* sendPacket(journey, body, {
      signature: Option.fromUndefinedOr(options.signature),
      event: "whatsapp.message.received",
    });
  });
const authenticateChatProvider = (
  journey: Awaited<ReturnType<typeof setup>>,
  reference: string
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const disclosureResponse = yield* Effect.tryPromise(() =>
      journey.send("/web/providers/disclosure")
    );
    const disclosure = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ revision: Schema.String })
    )(yield* Effect.tryPromise(() => disclosureResponse.json()));
    const start = yield* Effect.tryPromise(() =>
      journey.send("/web/providers/google/start", {
        ...journey.pairing,
        intent: "signup",
        consentRevision: disclosure.revision,
        ...(reference === "" ? {} : { handoffReference: reference }),
      })
    );
    expect(start.status).toBe(200);
    const result = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ authorizationUrl: Schema.String })
    )(yield* Effect.tryPromise(() => start.json()));
    const authorization = new URL(result.authorizationUrl);
    const { generateKeyPair, exportJWK, SignJWT } = yield* Effect.tryPromise(() => import("jose"));
    const keys = yield* Effect.tryPromise(() => generateKeyPair("RS256"));
    const jwk = yield* Effect.tryPromise(() => exportJWK(keys.publicKey));
    const token = yield* Effect.tryPromise(() =>
      new SignJWT({ nonce: authorization.searchParams.get("nonce"), email: "person@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: "chat" })
        .setIssuer("https://accounts.google.com")
        .setSubject("chat-provider-user")
        .setAudience("test-client")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey)
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(Response.json({ id_token: token }));
      }
      if (url === "https://www.googleapis.com/oauth2/v3/certs") {
        return Promise.resolve(Response.json({ keys: [{ ...jwk, kid: "chat", alg: "RS256" }] }));
      }
      if (url.startsWith("https://api.kapso.ai/")) {
        return Promise.resolve(
          Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.association-review" }],
          })
        );
      }
      return Promise.reject(new Error("Unexpected external destination"));
    });
    expect(
      (yield* Effect.tryPromise(() =>
        journey.send(
          `/providers/google/callback?state=${authorization.searchParams.get("state")}&code=fixture`,
          undefined,
          { cookie: start.headers.get("set-cookie")?.split(";")[0] ?? "" }
        )
      )).status
    ).toBe(303);
  });
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
    expect((yield* sendChat(journey, "Estado")).status).toBe(200);
    return review.associationCode;
  });
it("requires exact originating caller and reply confirmation, then atomically creates the WhatsApp User and redeems only with private browser proof", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(setupWhatsApp);
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
      expect((yield* sendChat(journey, "Estado")).status).toBe(200);
      const command = `Confirmo asociación ${review.associationCode}`;
      expect(
        (yield* sendChat(journey, command, {
          caller: "CO.Person2",
          reply: "wamid.association-review",
        })).status
      ).toBe(409);
      expect((yield* sendChat(journey, command, { reply: "different" })).status).toBe(409);
      expect(
        (yield* sendChat(journey, command, {
          reply: "wamid.association-review",
          signature: "forged",
        })).status
      ).toBe(401);
      expect(
        (yield* Effect.tryPromise(() => journey.db.prepare("SELECT id FROM users").all())).results
      ).toEqual([]);
      yield* Effect.sleep("1100 millis");
      expect(
        (yield* sendChat(journey, command, { reply: "wamid.association-review" })).status
      ).toBe(200);
      expect(
        (yield* sendChat(journey, command, { reply: "wamid.association-review" })).status
      ).toBe(409);
      const completed = yield* Effect.tryPromise(() =>
        journey.send("/web/providers/google/complete", journey.pairing)
      );
      expect(completed.status).toBe(200);
      expect(completed.headers.get("set-cookie")).toBeNull();
      const created = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ status: Schema.Literal("created"), backupRecoveryCode: Schema.String })
      )(yield* Effect.tryPromise(() => completed.json()));
      expect(created.backupRecoveryCode.length).toBeGreaterThan(20);
      const association = yield* Effect.tryPromise(() =>
        journey.db.prepare("SELECT portfolio_id,bsuid FROM whatsapp_identities").all()
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
      const journey = yield* Effect.tryPromise(setupWhatsApp);
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
      expect((yield* sendChat(journey, "Hola")).status).toBe(200);
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
        (yield* sendPacket(
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
      expect((yield* sendChat(journey, "Acepto")).status).toBe(409);
      yield* Effect.sleep("3100 millis");
      const acceptedAt = yield* Clock.currentTimeMillis;
      expect(
        (yield* sendChat(journey, "Acepto", { timestamp: Math.floor(acceptedAt / 1000) + 299 }))
          .status
      ).toBe(200);
      const handoffText = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ text: Schema.Struct({ body: Schema.String }) })
      )(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(outbound[1] ?? ""));
      expect(handoffText.text.body).toContain("/auth/google?handoff=");
      expect(handoffText.text.body).toContain("Google o Microsoft");
      const reference = /handoff=([0-9a-f-]{36})/u.exec(handoffText.text.body)?.[1] ?? "";
      yield* authenticateChatProvider(journey, reference);
      const code = yield* requestReview(journey);
      yield* Effect.sleep("1100 millis");
      expect(
        (yield* sendChat(journey, `Confirmo asociación ${code}`, {
          reply: "wamid.association-review",
        })).status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", journey.pairing)
        )).status
      ).toBe(200);

      expect(
        (yield* Effect.tryPromise(() =>
          journey.db.prepare("SELECT id FROM pending_email_enrollments").all()
        )).results
      ).toEqual([]);
    })
  ));

it.each(["denied", "expired", "uncertain_send"] as const)(
  "refuses %s association without stable effects or repeated delivery",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const journey = yield* Effect.tryPromise(setupWhatsApp);
        const reference = yield* seedAcceptedChat(journey.db);
        yield* authenticateChatProvider(journey, reference);
        if (scenario === "uncertain_send") {
          const fetch = vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValue(new Error("lost native send response"))
            .mockClear();
          expect((yield* sendChat(journey, "Estado")).status).toBe(503);
          expect((yield* sendChat(journey, "Estado")).status).toBe(503);
          expect(fetch).toHaveBeenCalledTimes(1);
        } else {
          const code = yield* requestReview(journey);
          yield* Effect.sleep("1100 millis");
          if (scenario === "expired") {
            yield* Effect.tryPromise(() =>
              journey.db
                .prepare("UPDATE whatsapp_provider_handoffs SET expires_at_ms=created_at_ms")
                .run()
            );
          }
          const command = `${scenario === "denied" ? "Rechazo" : "Confirmo"} asociación ${code}`;
          expect(
            (yield* sendChat(journey, command, { reply: "wamid.association-review" })).status
          ).toBe(scenario === "denied" ? 200 : 409);
          expect(
            (yield* sendChat(journey, `Confirmo asociación ${code}`, {
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

it("rolls back a failed association commit and permits exactly one concurrent successful completion", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(setupWhatsApp);
      yield* authenticateChatProvider(journey, yield* seedAcceptedChat(journey.db));
      const code = yield* requestReview(journey);
      yield* Effect.sleep("1100 millis");
      const confirmations = yield* Effect.all(
        [
          sendChat(journey, `Confirmo asociación ${code}`, { reply: "wamid.association-review" }),
          sendChat(journey, `Confirmo asociación ${code}`, { reply: "wamid.association-review" }),
        ],
        { concurrency: "unbounded" }
      );
      expect(
        confirmations.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([200, 409]);
      yield* Effect.tryPromise(() =>
        journey.db
          .prepare(
            "CREATE TRIGGER fixture_refuse BEFORE INSERT ON completed_provider_authentications BEGIN SELECT RAISE(ABORT,'fixture_failure'); END"
          )
          .run()
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
          journey.db.prepare("SELECT user_id FROM whatsapp_identities").all()
        )).results
      ).toEqual([]);
      yield* Effect.tryPromise(() => journey.db.prepare("DROP TRIGGER fixture_refuse").run());
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
    })
  ));

it.each([false, true])(
  "initially links a web-created User while refusing existing association conflicts: %s",
  (conflict) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const journey = yield* Effect.tryPromise(setupWhatsApp);
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
              "SELECT (SELECT COUNT(*) FROM trial_periods) trial,(SELECT COUNT(*) FROM backup_recovery_credentials) recovery,(SELECT COUNT(*) FROM onboarding_consent_records) consent"
            )
            .first()
        );
        if (conflict) {
          yield* Effect.tryPromise(() =>
            journey.db
              .prepare(
                "INSERT INTO whatsapp_identities(user_id,portfolio_id,bsuid,verified_at_ms) SELECT id,'portfolio','CO.Existing',created_at_ms FROM users"
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
        yield* Effect.sleep("1100 millis");
        expect(
          (yield* sendChat(chatJourney, `Confirmo asociación ${code}`, {
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
                "SELECT (SELECT COUNT(*) FROM trial_periods) trial,(SELECT COUNT(*) FROM backup_recovery_credentials) recovery,(SELECT COUNT(*) FROM onboarding_consent_records) consent"
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
      const journey = yield* Effect.tryPromise(setupWhatsApp);
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
      expect((yield* sendChat(journey, "Reiniciar")).status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.db
            .prepare("SELECT id FROM whatsapp_provider_handoffs WHERE id<>?")
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
  Effect.tryPromise(() =>
    db.prepare("UPDATE whatsapp_provider_handoffs SET expires_at_ms=created_at_ms").run()
  ).pipe(Effect.asVoid);

it.each(["source", "spend", "storage"] as const)(
  "refuses native sends when %s admission fails",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const journey = yield* Effect.tryPromise(setupWhatsApp);
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
            expect((yield* sendChat(journey, "Reiniciar")).status).toBe(200);
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
          [sendChat(journey, "Reiniciar"), sendChat(journey, "Reiniciar")],
          { concurrency: "unbounded" }
        );
        expect(refused.every((result) => result.status === 503 || result.status === 409)).toBe(
          true
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(
          yield* Effect.tryPromise(() =>
            journey.db
              .prepare(
                "SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM whatsapp_identities) associations,(SELECT COUNT(*) FROM web_sessions) sessions"
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
      const journey = yield* Effect.tryPromise(setupWhatsApp);
      yield* authenticateChatProvider(journey, yield* seedAcceptedChat(journey.db));
      const code = yield* requestReview(journey);
      yield* Effect.sleep("1100 millis");
      expect(
        (yield* sendChat(journey, `Confirmo asociación ${code}`, {
          reply: "wamid.association-review",
        })).status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", journey.pairing)
        )).status
      ).toBe(200);
      const durable =
        "SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM provider_credentials) credentials,(SELECT COUNT(*) FROM onboarding_consent_records) consent,(SELECT COUNT(*) FROM trial_periods) trials,(SELECT COUNT(*) FROM backup_recovery_credentials) recovery,(SELECT COUNT(*) FROM whatsapp_identities) associations";
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
              "SELECT (SELECT COUNT(*) FROM whatsapp_provider_handoffs) handoffs,(SELECT COUNT(*) FROM provider_authentication_attempts) attempts,(SELECT COUNT(*) FROM completed_provider_authentications) receipts"
            )
            .first()
        )
      ).toEqual({ handoffs: 0, attempts: 0, receipts: 0 });
      expect(
        (yield* sendChat(journey, `Confirmo asociación ${code}`, {
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
