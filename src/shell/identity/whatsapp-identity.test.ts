import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { MigrationSqlClient } from "~/shell/db/client";
import {
  E164PhoneNumber,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import {
  defaultUserId,
  defaultWhatsAppPhone,
  seedDevelopmentIdentity,
} from "~/shell/db/development-seed";
import { defaultAgentBearer } from "~/shell/testing/identity-fixtures";
import { makeKapsoIdentityChangeBody } from "~/shell/testing/kapso-identity-change";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";
import { associateWhatsAppIdentity, findWhatsAppIdentity, resolveWhatsAppCaller } from "./repo";

import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
const replacementPhone = E164PhoneNumber.make("+573009876543");
const postIdentityChange = (body: Uint8Array) =>
  HttpClient.post("/webhooks/kapso/meta", {
    headers: {
      "x-webhook-signature": new Bun.CryptoHasher("sha256", "test-webhook-secret-32-characters")
        .update(body)
        .digest("hex"),
    },
    body: HttpBody.uint8Array(body, "application/json"),
  });

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "WhatsAppIdentity caller resolution",
  (it) => {
    it.effect("does not resolve a different BSUID from matching phone evidence", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        const impersonatingCaller = {
          ...testWhatsAppCaller(defaultWhatsAppPhone),
          businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.differentcaller"),
        };

        const resolved = yield* resolveWhatsAppCaller(impersonatingCaller);
        const original = yield* resolveWhatsAppCaller(testWhatsAppCaller(defaultWhatsAppPhone));

        expect(Option.isNone(resolved)).toBe(true);
        expect(Option.getOrThrow(original)).toBe(defaultUserId);
      })
    );

    it.effect(
      "reassociates an authenticated provider change while preserving financial ownership",
      () =>
        Effect.gen(function* () {
          const admin = yield* MigrationSqlClient;
          yield* admin`DELETE FROM whatsapp_identity_change_evidence`;
          yield* seedDevelopmentIdentity(defaultAgentBearer);
          yield* truncateTransactions;
          const client = yield* ApiHarnessClient;
          const created = yield* client.transactions.createTransaction({
            payload: transactionPayload(),
          });

          const before = yield* resolveWhatsAppCaller(testWhatsAppCaller(defaultWhatsAppPhone));
          const replacementCaller = testWhatsAppCaller(replacementPhone);
          const body = makeKapsoIdentityChangeBody();
          const signature = new Bun.CryptoHasher("sha256", "test-webhook-secret-32-characters")
            .update(body)
            .digest("hex");
          const forged = yield* HttpClient.post("/webhooks/kapso/meta", {
            headers: { "x-webhook-signature": "0".repeat(64) },
            body: HttpBody.uint8Array(body, "application/json"),
          });
          const afterForgery = yield* resolveWhatsAppCaller(
            testWhatsAppCaller(defaultWhatsAppPhone)
          );
          const forgedReplacement = yield* resolveWhatsAppCaller(replacementCaller);
          const response = yield* HttpClient.post("/webhooks/kapso/meta", {
            headers: { "x-webhook-signature": signature },
            body: HttpBody.uint8Array(body, "application/json"),
          });
          const replaced = yield* response.json;
          const replay = yield* HttpClient.post("/webhooks/kapso/meta", {
            headers: { "x-webhook-signature": signature },
            body: HttpBody.uint8Array(body, "application/json"),
          });
          const unknownBody = makeKapsoIdentityChangeBody({
            previousBsuid: "CO.unknownprevious",
            replacementBsuid: "CO.unknownreplacement",
          });
          const unknownSignature = new Bun.CryptoHasher(
            "sha256",
            "test-webhook-secret-32-characters"
          )
            .update(unknownBody)
            .digest("hex");
          const deferred = yield* HttpClient.post("/webhooks/kapso/meta", {
            headers: { "x-webhook-signature": unknownSignature },
            body: HttpBody.uint8Array(unknownBody, "application/json"),
          });
          const retired = yield* resolveWhatsAppCaller(testWhatsAppCaller(defaultWhatsAppPhone));
          const reassociated = yield* resolveWhatsAppCaller(replacementCaller);
          const phoneLess = yield* resolveWhatsAppCaller({
            ...replacementCaller,
            phoneNumber: Option.none(),
          });
          const otherPortfolio = yield* resolveWhatsAppCaller({
            ...replacementCaller,
            businessPortfolioId: WhatsAppBusinessPortfolioId.make("other-portfolio"),
            phoneNumber: Option.none(),
          });
          const after = yield* client.transactions.listTransactions({ query: {} });

          expect(Option.getOrThrow(before)).toBe(defaultUserId);
          expect(forged.status).toBe(401);
          expect(Option.getOrThrow(afterForgery)).toBe(defaultUserId);
          expect(Option.isNone(forgedReplacement)).toBe(true);
          expect(response.status).toBe(200);
          expect(replaced).toMatchObject({ decoded: 1, acknowledged: 1 });
          expect(replay.status).toBe(200);
          expect(deferred.status).toBe(503);
          expect(Option.isNone(retired)).toBe(true);
          expect(Option.getOrThrow(reassociated)).toBe(defaultUserId);
          expect(Option.getOrThrow(phoneLess)).toBe(defaultUserId);
          expect(Option.isNone(otherPortfolio)).toBe(true);
          expect(after.data).toEqual([created.data]);
          expect(
            yield* admin`SELECT provider_message_id AS "providerMessageId", applied
                         FROM whatsapp_identity_change_evidence`
          ).toEqual([{ providerMessageId: "wamid.identity-change-001", applied: true }]);
        })
    );

    it.effect("deduplicates concurrent delivery and never regresses an advanced association", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        yield* admin`DELETE FROM whatsapp_identity_change_evidence`;
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        const body = makeKapsoIdentityChangeBody();
        const post = () => postIdentityChange(body);

        const concurrent = yield* Effect.all([post(), post()], { concurrency: "unbounded" });
        expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
        expect(
          yield* admin`SELECT count(*)::int AS count FROM whatsapp_identity_change_evidence`
        ).toEqual([{ count: 1 }]);

        const advancedPhone = E164PhoneNumber.make("+573007777777");
        yield* associateWhatsAppIdentity(defaultUserId, {
          ...testWhatsAppCaller(advancedPhone),
          verifiedAt: DateTime.makeUnsafe("2026-04-03T12:01:00Z"),
        });
        expect((yield* post()).status).toBe(200);
        expect(
          Option.getOrThrow(yield* resolveWhatsAppCaller(testWhatsAppCaller(advancedPhone)))
        ).toBe(defaultUserId);
        expect(
          Option.isNone(yield* resolveWhatsAppCaller(testWhatsAppCaller(replacementPhone)))
        ).toBe(true);
      })
    );

    it.effect("keeps the newest authority when reverse transitions arrive out of order", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        yield* admin`DELETE FROM whatsapp_identity_change_evidence`;
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        const reverse = makeKapsoIdentityChangeBody({
          providerMessageId: "wamid.identity-change-reverse",
          previousBsuid: "CO.573009876543",
          replacementBsuid: "CO.573001234567",
          phoneNumber: "573001234567",
        });
        const delayedForward = makeKapsoIdentityChangeBody({
          providerMessageId: "wamid.identity-change-delayed",
          timestamp: "1775217500",
        });

        expect((yield* postIdentityChange(reverse)).status).toBe(200);
        expect((yield* postIdentityChange(delayedForward)).status).toBe(200);
        expect(
          Option.getOrThrow(yield* resolveWhatsAppCaller(testWhatsAppCaller(defaultWhatsAppPhone)))
        ).toBe(defaultUserId);
        expect(
          Option.isNone(yield* resolveWhatsAppCaller(testWhatsAppCaller(replacementPhone)))
        ).toBe(true);
        expect(
          yield* admin`SELECT provider_message_id AS "providerMessageId", applied
                       FROM whatsapp_identity_change_evidence ORDER BY provider_message_id`
        ).toEqual([
          { providerMessageId: "wamid.identity-change-delayed", applied: false },
          { providerMessageId: "wamid.identity-change-reverse", applied: false },
        ]);
      })
    );

    it.effect("clears absent replacement phone evidence and ignores stale transitions", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        yield* admin`DELETE FROM whatsapp_identity_change_evidence`;
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        const phoneLessBody = makeKapsoIdentityChangeBody({
          providerMessageId: "wamid.identity-change-phoneless",
          includePhoneNumber: false,
        });
        expect((yield* postIdentityChange(phoneLessBody)).status).toBe(200);
        const phoneLessIdentity = Option.getOrThrow(yield* findWhatsAppIdentity(defaultUserId));
        expect(Option.isNone(phoneLessIdentity.phoneNumber)).toBe(true);

        yield* admin`DELETE FROM whatsapp_identity_change_evidence`;
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        const staleBody = makeKapsoIdentityChangeBody({
          providerMessageId: "wamid.identity-change-stale",
          timestamp: "1",
          replacementBsuid: "CO.stalereplacement",
        });
        expect((yield* postIdentityChange(staleBody)).status).toBe(200);
        expect(
          Option.getOrThrow(yield* resolveWhatsAppCaller(testWhatsAppCaller(defaultWhatsAppPhone)))
        ).toBe(defaultUserId);
        expect(
          Option.isNone(
            yield* resolveWhatsAppCaller({
              ...testWhatsAppCaller(replacementPhone),
              businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.stalereplacement"),
            })
          )
        ).toBe(true);
        expect(
          yield* admin`SELECT applied FROM whatsapp_identity_change_evidence
                       WHERE provider_message_id = 'wamid.identity-change-stale'`
        ).toEqual([{ applied: false }]);
      })
    );
  }
);
