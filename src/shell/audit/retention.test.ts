import { expect, layer } from "@effect/vitest";
import { ConfigProvider, DateTime, Duration, Effect } from "effect";
import { CanonicalOperationId } from "~/core/audit/model";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import { truncateAuditLogEntries } from "./fixtures";
import { appendAuditLogEntry, observeAuditLogEntries } from "./repo";
import { auditRetentionDuration, runConfiguredAuditRetention } from "./retention";

const configuredFor = (value: string) =>
  ConfigProvider.fromUnknown({ FIDY_AUDIT_RETENTION: value });

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "AuditLogEntry retention",
  (it) => {
    it.effect("defaults the retention window to approximately twelve months", () =>
      Effect.gen(function* () {
        const retention = yield* auditRetentionDuration;

        expect(Duration.toDays(retention)).toBe(365);
      }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})))
    );

    it.effect("rejects invalid retention without deleting evidence", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;
        const client = yield* ApiHarnessClient;
        yield* client.identity.getCurrentUser();
        const before = yield* observeAuditLogEntries(defaultUserId);

        for (const value of ["299 days", "401 days", "not-a-duration"]) {
          const result = yield* Effect.result(
            runConfiguredAuditRetention(DateTime.makeUnsafe("2026-07-01T12:00:00Z")).pipe(
              Effect.provideService(ConfigProvider.ConfigProvider, configuredFor(value))
            )
          );

          expect(result._tag, value).toBe("Failure");
          expect(yield* observeAuditLogEntries(defaultUserId), value).toEqual(before);
        }
      })
    );

    it.effect("removes only evidence older than the configured cutoff", () =>
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

        yield* runConfiguredAuditRetention(now).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configuredFor("365 days"))
        );

        const retained = yield* observeAuditLogEntries(defaultUserId);
        expect(retained.map((entry) => entry.occurredAt)).toEqual([
          cutoff,
          DateTime.makeUnsafe("2025-07-01T12:00:01Z"),
        ]);
      })
    );
  }
);
