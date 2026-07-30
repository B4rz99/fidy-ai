import { expect, layer } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { CanonicalOperationId } from "~/core/audit/model";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import { truncateAuditLogEntries } from "./fixtures";
import { appendAuditLogEntry, observeAuditLogEntries } from "./repo";
import { runAuditRetention } from "./retention";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "AuditLogEntry retention",
  (it) => {
    it.effect("removes only evidence older than the 365-day cutoff", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;
        const client = yield* ApiHarnessClient;
        yield* client.identity.getCurrentUser();
        const [attributed] = yield* observeAuditLogEntries(defaultUserId);
        if (attributed === undefined) return yield* Effect.die("missing attributable token");

        yield* truncateAuditLogEntries;
        const now = DateTime.makeUnsafe("2026-07-01T12:00:00Z");
        const cutoff = DateTime.makeUnsafe("2025-07-01T12:00:00Z");
        const entries = [
          { operation: "identity.getCurrentUser", occurredAt: "2025-07-01T11:59:59Z" },
          { operation: "transactions.listTransactions", occurredAt: "2025-07-01T12:00:00Z" },
          { operation: "identity.updateUserPreferences", occurredAt: "2025-07-01T12:00:01Z" },
        ] as const;

        yield* Effect.forEach(entries, (entry) =>
          appendAuditLogEntry(defaultUserId, {
            tokenId: attributed.tokenId,
            operation: CanonicalOperationId.make(entry.operation),
            outcome: "succeeded",
            occurredAt: DateTime.makeUnsafe(entry.occurredAt),
          })
        );

        yield* runAuditRetention(now);

        const retained = yield* observeAuditLogEntries(defaultUserId);
        expect(retained.map((entry) => entry.occurredAt)).toEqual([
          cutoff,
          DateTime.makeUnsafe("2025-07-01T12:00:01Z"),
        ]);
      })
    );
  }
);
