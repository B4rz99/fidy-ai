import { expect, layer } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { UserId } from "~/core/identity/reference";
import { PATId } from "~/core/tokens/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { MigrationSqlClient } from "~/shell/db/client";
import { withUserTransaction } from "~/shell/db/user-transaction";
import type { CanonicalCaller } from "./authz";
import { executeCanonicalEffect } from "./canonical-operation-executor";
import { patScoped } from "./operation-policy";
import { activatePaidProInScope } from "~/shell/subscription/access-repo";
import { ApiHarness } from "~/shell/testing/api-harness";
import { upsertStableUserFixture } from "~/shell/testing/identity-fixtures";
import { resolveAccessTierInScope } from "./access-tier";

const firstUserId = UserId.make("f1d1a000-0000-4000-8000-00000000a551");
const secondUserId = UserId.make("f1d1a000-0000-4000-8000-00000000a552");
const firstPatId = PATId.make("f1d1a000-0000-4000-8000-00000000a553");
const afterTrial = DateTime.makeUnsafe("2026-09-01T00:00:00Z");

const clearFixtures = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM audit_log_entries WHERE user_id IN (${firstUserId}, ${secondUserId})
      `;
      yield* sql`
        DELETE FROM consent_records WHERE subject_user_id IN (${firstUserId}, ${secondUserId})
      `;
      yield* sql`DELETE FROM users WHERE id IN (${firstUserId}, ${secondUserId})`;
    })
  );
});

const installExpiredTrialFixtures = Effect.gen(function* () {
  yield* clearFixtures;
  const createdAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");
  yield* upsertStableUserFixture(firstUserId, yield* makeColombianUser(firstUserId, { createdAt }));
  yield* upsertStableUserFixture(
    secondUserId,
    yield* makeColombianUser(secondUserId, { createdAt })
  );
  const sql = yield* MigrationSqlClient;
  yield* sql`
    INSERT INTO tokens (
      id, user_id, short_id, recipient_label, token_hash, scopes, lifetime_days, expires_at,
      created_at
    ) VALUES (
      ${firstPatId}, ${firstUserId}, 'tierchec', 'Tier check', ${"c".repeat(64)},
      ARRAY['write'], 90, '2026-10-30T12:00:00Z', ${createdAt}
    )
  `;
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "User-scoped AccessTier resolution",
  (it) => {
    it.effect("rolls paid Pro activation back with its enclosing transaction", () =>
      Effect.gen(function* () {
        yield* installExpiredTrialFixtures;
        expect(
          yield* withUserTransaction(firstUserId, resolveAccessTierInScope(firstUserId, afterTrial))
        ).toBe("free");

        const rollbackReason = yield* withUserTransaction(
          firstUserId,
          Effect.gen(function* () {
            yield* activatePaidProInScope(firstUserId);
            expect(yield* resolveAccessTierInScope(firstUserId, afterTrial)).toBe("pro");
            return yield* Effect.fail("rollback" as const);
          })
        ).pipe(Effect.flip);

        expect(rollbackReason).toBe("rollback");
        expect(
          yield* withUserTransaction(firstUserId, resolveAccessTierInScope(firstUserId, afterTrial))
        ).toBe("free");
      }).pipe(Effect.ensuring(clearFixtures.pipe(Effect.orDie)))
    );

    it.effect("rejects Pro execution before its transaction can mutate Free standing", () =>
      Effect.gen(function* () {
        yield* installExpiredTrialFixtures;
        const caller: CanonicalCaller = {
          subjectUserId: firstUserId,
          capabilities: ["write"],
          authorityRoot: "no-verified-whatsapp-authority",
          auditCaller: {
            _tag: "PAT",
            patId: firstPatId,
          },
        };

        const rejection = yield* executeCanonicalEffect({
          caller,
          operation: CanonicalOperationId.make("transactions.createTransaction"),
          policy: {
            access: patScoped("write"),
            requiredTier: "pro",
            agentConfirmation: "not-required",
            kind: "mutation",
          },
          effect: () => activatePaidProInScope(firstUserId),
          executionCheckpoint: Effect.void,
          occurredAt: afterTrial,
        }).pipe(Effect.flip);

        expect(rejection).toMatchObject({ _tag: "CanonicalCallRejected", reason: "tier_missing" });
        expect(
          yield* withUserTransaction(firstUserId, resolveAccessTierInScope(firstUserId, afterTrial))
        ).toBe("free");
      }).pipe(Effect.ensuring(clearFixtures.pipe(Effect.orDie)))
    );

    it.effect("keeps paid standing isolated by the transaction UserId", () =>
      Effect.gen(function* () {
        yield* installExpiredTrialFixtures;
        yield* withUserTransaction(firstUserId, activatePaidProInScope(firstUserId));

        expect(
          yield* withUserTransaction(firstUserId, resolveAccessTierInScope(firstUserId, afterTrial))
        ).toBe("pro");
        expect(
          yield* withUserTransaction(
            secondUserId,
            resolveAccessTierInScope(secondUserId, afterTrial)
          )
        ).toBe("free");

        const crossUserRows = yield* withUserTransaction(
          firstUserId,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`
              SELECT user_id FROM subscriptions WHERE user_id = ${secondUserId}
            `;
          })
        );
        expect(crossUserRows).toEqual([]);
      }).pipe(Effect.ensuring(clearFixtures.pipe(Effect.orDie)))
    );
  }
);
