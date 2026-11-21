import type { Miniflare } from "miniflare";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { Hex } from "effect/encoding";
import { expect } from "vitest";
import { alice, bob, seed } from "../financial-user-store.test-fixture";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";
import { browserOrigins, productionTopology } from "../runtime/contract";
import { claimDeliveryUrl, replyDeliveryUrl, reserveDeliveryUrl } from "./contract";

const portfolio = "123456789012345",
  endpoint = "8444555566667",
  bsuid = "CO.13491208655302741918",
  token = "22430000-0000-4000-8000-000000000008",
  operationId = "22430000-0000-4000-8000-000000000007";

const message = "wamid.verified-callback";

const notifier = (
  runtime: Miniflare,
  key: CryptoKey
): ((
  recipient: string,
  valid: boolean,
  occurredAt: number
) => Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>, Schema.SchemaError>) =>
  Effect.fn(function* (recipient: string, valid: boolean, occurredAt: number) {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      phone_number_id: endpoint,
      message: {
        id: message,
        kapso: {
          direction: "outbound",
          status: "delivered",
          statuses: [
            {
              id: message,
              status: "delivered",
              timestamp: String(Math.floor(occurredAt / 1000)),
              recipient_user_id: recipient,
              biz_opaque_callback_data: token,
            },
          ],
        },
      },
    });

    const signed = Hex.encode(
      new Uint8Array(
        yield* native(() => crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
      )
    );

    return yield* native(() =>
      runtime.dispatchFetch(
        `https://${productionTopology.ingress.hostname}/providers/kapso/callback`,
        {
          method: "POST",
          headers: {
            "x-webhook-signature": valid ? signed : "0".repeat(64),
            "x-webhook-event": "whatsapp.message.delivered",
            "x-idempotency-key": "fixture-delivery",
          },
          body,
        }
      )
    );
  });

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect.each([false, true])(
    "retains exact signed delivery evidence across a lost send reply with erasure requested=%s",
    (erase) =>
      Effect.gen(function* () {
        const create = yield* nativeBillingPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);
        const other = yield* seed(runtime, bob);
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('grant',?,'processing_grant',?)",
          alice.user,
          owner.now
        );
        yield* owner.exec(
          "UPDATE users SET whatsapp_portfolio_id=?,whatsapp_bsuid=?,whatsapp_verified_at_ms=? WHERE id=?",
          portfolio,
          bsuid,
          owner.now,
          alice.user
        );
        const owners = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

        const privateCall = (
          url: string,
          body: unknown,
          id = alice.user
        ): Effect.Effect<Awaited<ReturnType<ReturnType<typeof owners.getByName>["fetch"]>>> =>
          native(() =>
            owners.getByName(id).fetch(url, { method: "POST", body: JSON.stringify(body) })
          );

        const now = yield* Clock.currentTimeMillis;

        const claim = {
          userId: alice.user,
          family: "hosted",
          operationId,
          correlation: token,
          endpoint,
          portfolio,
          bsuid,
          sandboxPhone: null,
          deadline: now + 120000,
          contentDigest: "c".repeat(64),
        };

        expect((yield* privateCall(claimDeliveryUrl, claim, bob.user)).status).toBe(409);
        expect((yield* privateCall(claimDeliveryUrl, claim)).status).toBe(409);
        expect((yield* privateCall(reserveDeliveryUrl, claim)).status).toBe(204);
        expect((yield* privateCall(claimDeliveryUrl, claim)).status).toBe(201);
        expect((yield* privateCall(claimDeliveryUrl, claim)).status).toBe(409);

        const requestErasure = (): ReturnType<typeof runtime.dispatchFetch> =>
          runtime.dispatchFetch(
            `https://${productionTopology.ingress.hostname}/web/privacy/erasure`,
            {
              method: "POST",
              headers: {
                origin: browserOrigins.production,
                "content-type": "application/json",
                "Fidy-Session-Binding": alice.session,
                cookie: "__Host-fidy_session=" + alice.bearer,
              },
              body: JSON.stringify({ confirm: true }),
            }
          );

        const eraseAndConfirm = Effect.gen(function* () {
          const accepted = yield* native(requestErasure);

          expect(accepted.status).toBe(202);
          expect(
            (yield* privateCall(replyDeliveryUrl, { ...claim, state: "ambiguous", message: null }))
              .status
          ).toBe(204);
          expect(yield* owner.exec("SELECT state FROM whatsapp_deliveries")).toEqual([
            { state: "ambiguous" },
          ]);
          expect((yield* privateCall(claimDeliveryUrl, claim)).status).toBe(409);
        });

        yield* erase ? eraseAndConfirm : Effect.void;

        const deliveredAt = yield* Clock.currentTimeMillis;

        const key = yield* native(() =>
          crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode("callback-fixture-secret"),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
          )
        );

        const notify = notifier(runtime, key);
        yield* native(() =>
          owner.directory.exec("ALTER TABLE external_event_routes RENAME TO offline")
        );
        expect((yield* notify(bsuid, true, deliveredAt)).status).toBe(200);
        expect(yield* owner.exec("SELECT state FROM whatsapp_deliveries")).toEqual([
          { state: erase ? "ambiguous" : "sending" },
        ]);
        yield* native(() =>
          owner.directory.exec("ALTER TABLE offline RENAME TO external_event_routes")
        );
        expect((yield* notify(bsuid, false, deliveredAt)).status).toBe(401);
        expect((yield* notify("CO.13491208655302741919", true, deliveredAt)).status).toBe(200);
        expect((yield* notify(bsuid, true, deliveredAt - 60000)).status).toBe(200);
        expect((yield* notify(bsuid, true, deliveredAt)).status).toBe(200);

        const proof = owner.exec(
          "SELECT provider_message_id,state,delivered_at_ms IS NOT NULL AS confirmed FROM whatsapp_deliveries"
        );

        yield* proof.pipe(
          Effect.filterOrFail(
            (rows) => rows[0]?.state === "delivered",
            () => "awaiting_status" as const
          ),
          Effect.retry({ times: 120, schedule: Schedule.spaced("50 millis") })
        );
        expect((yield* notify(bsuid, true, deliveredAt)).status).toBe(200);
        expect(
          (yield* privateCall(replyDeliveryUrl, { ...claim, state: "ambiguous", message: null }))
            .status
        ).toBe(204);
        expect(yield* proof).toEqual([
          { provider_message_id: message, state: "delivered", confirmed: 1 },
        ]);
        expect(yield* owner.exec("SELECT count(*) AS n FROM whatsapp_delivery_status")).toEqual([
          { n: 1 },
        ]);
        expect(yield* other.exec("SELECT count(*) AS n FROM whatsapp_delivery_status")).toEqual([
          { n: 0 },
        ]);
        yield* owner.exec(
          "UPDATE users SET whatsapp_bsuid='CO.13491208655302741919' WHERE id=?",
          alice.user
        );
        expect(
          (yield* privateCall(claimDeliveryUrl, {
            ...claim,
            operationId: "other",
            correlation: "22430000-0000-4000-8000-000000000009",
          })).status
        ).toBe(409);
      })
  );
});
