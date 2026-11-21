import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import { webSignupDisclosure } from "../../src/shell/consent/operations";
import { maxWhatsAppWebhookBytes } from "../../src/shell/consent/contract";
import { browser, chatWith, signedWebhook } from "../browser-bootstrap.test-fixture";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";

const caller = "CO.Original";

const firstMessage = "wamid.invitation";

const complete = "/web/providers/google/complete";

const evidence =
  "SELECT (SELECT count(*) FROM whatsapp_invitations) AS invitations,(SELECT count(*) FROM provider_routes) AS providers,(SELECT count(*) FROM whatsapp_routes) AS channels,(SELECT count(*) FROM bootstrap_admissions WHERE scope='whatsapp-sends') AS sends";

const setup = Effect.fn(function* (deployment: Readonly<Record<string, string>> = {}) {
  const runtime = yield* (yield* nativeBrowserPlatform)(undefined, [], deployment);
  const web = browser(runtime);
  yield* web.pair;

  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  const exec = Effect.fn(function* (query: string, ...params: Array<string | number>) {
    return yield* native(() => directory.exec(query, ...params));
  });

  const send = Effect.fn(function* (options: Omit<Parameters<typeof chatWith>[1], "caller">) {
    const response = yield* chatWith(runtime, { caller, ...options });
    yield* native(() => response.arrayBuffer());

    return response.status;
  });

  const review = Effect.gen(function* () {
    expect(yield* send({ text: "Hola", message: firstMessage })).toBe(200);

    const [row] = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ id: Schema.String }))
    )(yield* exec("SELECT id FROM whatsapp_invitations WHERE message=?", firstMessage));

    if (row === undefined) return yield* Effect.die("Missing invitation");
    const flow = yield* web.verified("registration", row.id);

    const approved = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ associationCode: Schema.String, confirmationText: Schema.String })
    )(flow.review);

    return { ...approved, proof: flow.proof };
  });

  return { runtime, web, exec, send, review };
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "rejects invalid signatures and oversized streams before charging an invitation or reserving an identity",
    () =>
      Effect.gen(function* () {
        const { runtime, exec, send } = yield* setup();
        expect(yield* send({ text: "Hola", secret: "incorrect" })).toBe(401);
        const bytes = new Uint8Array(maxWhatsAppWebhookBytes + 1);
        const tooLarge = yield* signedWebhook(runtime, bytes, "test-kapso-secret");
        expect(tooLarge.status).toBe(413);
        yield* native(() => tooLarge.arrayBuffer());
        expect(yield* exec(evidence)).toEqual([
          { invitations: 0, providers: 0, channels: 0, sends: 0 },
        ]);
      })
  );
  test.effect(
    "releases only a definitively rejected invitation, suppresses signed redelivery, and admits a fresh original greeting",
    () =>
      Effect.gen(function* () {
        const { runtime, exec, send, web } = yield* setup();

        const refused = {
          text: "Hola",
          phone: "573001234599",
          message: "wamid.provider-rejected",
          occurredMs: yield* Clock.currentTimeMillis,
        };

        expect(yield* send(refused)).toBe(200);
        expect(yield* send(refused)).toBe(409);
        expect(yield* send({ text: "Hola", message: "wamid.replacement" })).toBe(200);
        expect(yield* send(refused)).toBe(409);
        expect(yield* exec(evidence)).toEqual([
          { invitations: 2, channels: 0, providers: 0, sends: 2 },
        ]);

        const [record] = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ id: Schema.String }))
        )(yield* exec("SELECT id FROM whatsapp_invitations WHERE message=?", refused.message));

        if (record === undefined) return yield* Effect.die("Missing rejection");

        const wrong = yield* web.post("/web/providers/google/start", {
          ...(yield* web.pair),
          intent: "signup",
          consentRevision: webSignupDisclosure().revision,
          handoffReference: record.id,
        });

        expect(wrong.status).toBe(400);
        yield* native(() => wrong.arrayBuffer());
        const delivered = "wamid.rejected-delivery";
        const timestamp = String(Math.floor(refused.occurredMs / 1000));

        const bytes = new TextEncoder().encode(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            phone_number_id: "123456789012345",
            message: {
              id: delivered,
              kapso: {
                direction: "outbound",
                status: "delivered",
                statuses: [
                  { id: delivered, status: "delivered", timestamp, recipient_user_id: caller },
                ],
              },
            },
          })
        );

        const callback = yield* signedWebhook(runtime, bytes, {
          secret: "test-kapso-secret",
          event: "whatsapp.message.delivered",
        });

        expect(callback.status).toBe(200);
        yield* native(() => callback.arrayBuffer());
        expect(
          yield* exec("SELECT decision FROM whatsapp_invitations WHERE message='wamid.replacement'")
        ).toEqual([{ decision: null }]);
      })
  );
  test.effect(
    "keeps generic chat decisions and an exact signed replay outside registration before browser review and after invitation expiry",
    () =>
      Effect.gen(function* () {
        const { exec, send } = yield* setup();
        const occurredMs = yield* Clock.currentTimeMillis;
        const original = { text: "Acepto", message: firstMessage, occurredMs: occurredMs + 60000 };
        expect(yield* send(original)).toBe(200);
        expect(yield* send(original)).toBe(200);
        expect(yield* send({ text: "No acepto" })).toBe(200);
        expect(yield* exec("SELECT decision,review_attempt FROM whatsapp_invitations")).toEqual([
          { decision: null, review_attempt: null },
        ]);
        yield* exec(
          "UPDATE whatsapp_invitations SET expires_at_ms=? WHERE message=?",
          occurredMs - 1,
          firstMessage
        );
        expect(yield* send(original)).toBe(200);
        expect(yield* exec(evidence)).toEqual([
          { invitations: 1, providers: 0, channels: 0, sends: 1 },
        ]);
        expect(yield* send({ text: "Hola", message: "wamid.new" })).toBe(200);
        expect(yield* exec(evidence)).toEqual([
          { invitations: 2, providers: 0, channels: 0, sends: 2 },
        ]);
        expect(
          yield* send({ text: "Hola", message: "wamid.stale", occurredMs: occurredMs - 86400000 })
        ).toBe(409);
      })
  );
  test.effect(
    "requires both receipt and signed occurrence after review and refuses a malformed association decision before reserving a User",
    () =>
      Effect.gen(function* () {
        const { exec, send, web, review } = yield* setup();
        const { proof, associationCode, confirmationText } = yield* review;
        const now = yield* Clock.currentTimeMillis;
        yield* exec("UPDATE whatsapp_invitations SET review_started_ms=?", now + 60000);
        expect(yield* send({ text: confirmationText, occurredMs: now + 90000 })).toBe(409);
        yield* exec("UPDATE whatsapp_invitations SET review_started_ms=?", now - 5000);
        expect(yield* send({ text: confirmationText, occurredMs: now - 8000 })).toBe(409);
        yield* exec(
          "UPDATE whatsapp_invitations SET decision='confirmed',decision_message='wamid.offline',confirmed_ms=review_started_ms-1"
        );
        const refused = yield* web.post(complete, { ...proof, associationCode });
        expect(refused.status).toBe(400);
        yield* native(() => refused.arrayBuffer());
        expect(yield* exec(evidence)).toEqual([
          { invitations: 1, providers: 0, channels: 0, sends: 1 },
        ]);
      })
  );
  test.effect.each(["123456789012345", "8444555566667"])(
    "stores the contextual reply and limits the signed phone to the configured sandbox on endpoint %s",
    (endpoint) =>
      Effect.gen(function* () {
        const { runtime, web, exec, send, review } = yield* setup({
          OPENAI_API_KEY: "fixture-openai",
          HOSTED_AI_MODEL: "gpt-6-luna",
        });

        const { proof, associationCode, confirmationText } = yield* review;
        const occurredMs = (yield* Clock.currentTimeMillis) + 2000;
        expect(yield* send({ text: confirmationText, occurredMs })).toBe(200);
        const result = yield* web.post(complete, { ...proof, associationCode });
        expect(result.status).toBe(200);
        yield* native(() => result.arrayBuffer());

        const [row] = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ user_id: Schema.String }))
        )(yield* exec("SELECT user_id FROM whatsapp_routes WHERE established=1"));

        if (row === undefined) return yield* Effect.die("Missing registered chat");

        const storage = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: row.user_id })
        );

        const request = {
          text: "¿Qué gasté hoy?",
          occurredMs,
          message: "wamid.turn",
          reply: "wamid.original",
          endpoint,
        };

        expect(yield* send({ ...request, secret: "incorrect" })).toBe(401);
        expect(yield* send(request)).toBe(202);
        expect(yield* send(request)).toBe(202);
        expect(
          yield* native(() =>
            storage.exec("SELECT message,reply_to,sandbox_phone FROM hosted_whatsapp_inbound")
          )
        ).toEqual([
          {
            message: request.message,
            reply_to: request.reply,
            sandbox_phone: endpoint === "123456789012345" ? "+573001234567" : null,
          },
        ]);
      })
  );
  test.effect(
    "commits a single exact decision under concurrent signed confirmation and refusal and preserves it on replay",
    () =>
      Effect.gen(function* () {
        const { web, exec, send, review } = yield* setup();
        const { proof, associationCode, confirmationText } = yield* review;
        const occurredMs = (yield* Clock.currentTimeMillis) + 2000;
        const accept = { text: confirmationText, message: "wamid.confirm", occurredMs };

        const deny = {
          text: confirmationText.replace(/^Vincular /u, "No vincular "),
          message: "wamid.deny",
          occurredMs,
        };

        const replies = yield* Effect.all([send(accept), send(deny)], { concurrency: 2 });
        expect([...replies].sort((left, right) => left - right)).toEqual([200, 409]);
        const confirmed = replies[0] === 200;

        const row = {
          decision: confirmed ? "confirmed" : "denied",
          decision_message: confirmed ? accept.message : deny.message,
        };

        expect(yield* exec("SELECT decision,decision_message FROM whatsapp_invitations")).toEqual([
          row,
        ]);
        expect(yield* send(accept)).toBe(409);
        expect(yield* send(deny)).toBe(409);
        const result = yield* web.post(complete, { ...proof, associationCode });
        expect(result.status).toBe(confirmed ? 200 : 400);
        yield* native(() => result.arrayBuffer());
        expect(yield* exec(evidence)).toEqual([
          { invitations: 1, providers: confirmed ? 1 : 0, channels: confirmed ? 1 : 0, sends: 1 },
        ]);
      })
  );
});
