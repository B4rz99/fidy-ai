import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { authenticateTokenBearer } from "~/shell/_shared/authz-live";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import { issueHostedTurnToken, revokeHostedTurnToken } from "./hosted-turn-token";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "hosted TokenBearer",
  (it) => {
    it.effect("rejects a HostedTurnToken after its non-renewable hard expiry", () =>
      Effect.gen(function* () {
        const usedAt = DateTime.makeUnsafe("2026-07-30T12:00:00Z");
        const createdAt = DateTime.subtractDuration(usedAt, "16 minutes");
        const issued = yield* issueHostedTurnToken(defaultUserId, createdAt);

        const resolved = yield* authenticateTokenBearer(issued.bearer, usedAt);

        expect(Option.isNone(resolved)).toBe(true);
      })
    );

    it.effect("rejects a HostedTurnToken after turn cleanup revokes it", () =>
      Effect.gen(function* () {
        const createdAt = DateTime.makeUnsafe("2026-07-30T12:00:00Z");
        const issued = yield* issueHostedTurnToken(defaultUserId, createdAt);
        yield* revokeHostedTurnToken(
          defaultUserId,
          issued.tokenId,
          DateTime.addDuration(createdAt, "1 minute")
        );

        const resolved = yield* authenticateTokenBearer(
          issued.bearer,
          DateTime.addDuration(createdAt, "2 minutes")
        );

        expect(Option.isNone(resolved)).toBe(true);
      })
    );
  }
);
