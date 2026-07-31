import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { authenticateAgentToken } from "~/shell/_shared/authz";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import { issueHostedAgentToken, revokeHostedAgentToken } from "./hosted-agent-token";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "hosted AgentToken",
  (it) => {
    it.effect("rejects a hosted bearer after its non-renewable hard expiry", () =>
      Effect.gen(function* () {
        const usedAt = DateTime.makeUnsafe("2026-07-30T12:00:00Z");
        const createdAt = DateTime.subtractDuration(usedAt, "16 minutes");
        const issued = yield* issueHostedAgentToken(defaultUserId, createdAt);

        const resolved = yield* authenticateAgentToken({ bearer: issued.bearer, usedAt });

        expect(Option.isNone(resolved)).toBe(true);
      })
    );

    it.effect("rejects a hosted bearer after turn cleanup revokes it", () =>
      Effect.gen(function* () {
        const createdAt = DateTime.makeUnsafe("2026-07-30T12:00:00Z");
        const issued = yield* issueHostedAgentToken(defaultUserId, createdAt);
        yield* revokeHostedAgentToken(
          defaultUserId,
          issued.tokenId,
          DateTime.addDuration(createdAt, "1 minute")
        );

        const resolved = yield* authenticateAgentToken({
          bearer: issued.bearer,
          usedAt: DateTime.addDuration(createdAt, "2 minutes"),
        });

        expect(Option.isNone(resolved)).toBe(true);
      })
    );
  }
);
