import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { E164PhoneNumber } from "~/core/identity/model";
import { authenticateAgentToken } from "~/shell/_shared/authz";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import {
  defaultUserId,
  defaultWhatsAppPhone,
  seedDevelopmentIdentity,
} from "~/shell/db/development-seed";
import { defaultAgentBearer } from "~/shell/testing/identity-fixtures";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";
import { associateWhatsAppIdentity, resolveWhatsAppCaller } from "./repo";

const replacementPhone = E164PhoneNumber.make("+573009876543");

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "WhatsAppIdentity caller resolution",
  (it) => {
    it.effect("reassociates the phone while preserving stable User ownership", () =>
      Effect.gen(function* () {
        yield* seedDevelopmentIdentity(defaultAgentBearer);
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const created = yield* client.transactions.createTransaction({
          payload: transactionPayload(),
        });

        const before = yield* resolveWhatsAppCaller(defaultWhatsAppPhone);
        const agentCaller = yield* authenticateAgentToken({
          bearer: defaultAgentBearer,
          usedAt: yield* DateTime.now,
        });
        yield* associateWhatsAppIdentity(defaultUserId, {
          phoneNumber: replacementPhone,
          verifiedAt: DateTime.makeUnsafe("2026-07-28T00:00:00Z"),
        });
        const retired = yield* resolveWhatsAppCaller(defaultWhatsAppPhone);
        const reassociated = yield* resolveWhatsAppCaller(replacementPhone);
        const after = yield* client.transactions.listTransactions({ query: {} });

        expect(Option.getOrThrow(before)).toBe(defaultUserId);
        expect(Option.getOrThrow(agentCaller)).toMatchObject({
          subjectUserId: defaultUserId,
          scopes: ["read", "write", "dashboard"],
        });
        expect(Option.isNone(retired)).toBe(true);
        expect(Option.getOrThrow(reassociated)).toBe(defaultUserId);
        expect(after.data).toEqual([created.data]);
      })
    );
  }
);
