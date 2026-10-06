import { Effect, Schema } from "effect";
import { admitResource } from "../resource-admission/operations";
import {
  ResourceAdmissionCharges,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnits,
} from "../resource-admission/contract";
import { newId } from "../secret-material/operations";

const uploadLeaseMillis = 600_000;
const uploadWindowMillis = 3_600_000;
const BudgetCase = Schema.Literals([
  "attempt-user",
  "attempt-global",
  "user",
  "global",
  "spend",
  "outstanding",
]);
export const UploadRefusalCase = Schema.Literals([
  "none",
  ...BudgetCase.literals,
  "paywall",
  "media-unavailable",
]);
export type UploadRefusalCase = typeof UploadRefusalCase.Type;
const budget = (
  kind: typeof BudgetCase.Type,
  userId: string
): Readonly<{
  key: string;
  scope: string;
  dimension: "stable_user" | "operation" | "spend" | "outstanding_work";
  limit: number;
}> => {
  switch (kind) {
    case "attempt-user":
      return { key: "attempt.user", scope: userId, dimension: "stable_user", limit: 40 };
    case "attempt-global":
      return {
        key: "attempt.global",
        scope: "statement-staging",
        dimension: "operation",
        limit: 1000,
      };
    case "user":
      return { key: "user", scope: userId, dimension: "stable_user", limit: 20 };
    case "global":
      return { key: "operation", scope: "statement-staging", dimension: "operation", limit: 500 };
    case "spend":
      return { key: "spend", scope: "r2-statement-staging", dimension: "spend", limit: 500 };
    case "outstanding":
      return { key: "outstanding", scope: userId, dimension: "outstanding_work", limit: 2 };
  }
};
type UploadRefusalFixture = Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  kind: UploadRefusalCase;
}>;
/** Exhaust the installed policy through its published admission seam, not a replacement limit. */
export const seedStatementUploadRefusal = ({
  db,
  userId,
  current,
  kind,
}: UploadRefusalFixture): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (kind === "none" || kind === "media-unavailable") return;
      if (kind === "paywall") {
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO statement_backfill_entitlements (user_id,submission_id,consumed_at_ms) VALUES (?,NULL,?)"
            )
            .bind(userId, current)
            .run()
        );
        return;
      }
      const selected = budget(kind, userId);
      const key = ResourceAdmissionPolicyKey.make(`ingestion.upload.${selected.key}.v1`);
      const limit = ResourceAdmissionLimit.make(selected.limit);
      const policies = ResourceAdmissionPolicies.make([
        selected.dimension === "outstanding_work"
          ? {
              key,
              limit,
              dimension: selected.dimension,
              kind: "outstanding",
              leaseMs: ResourceAdmissionDurationMs.make(uploadLeaseMillis),
            }
          : {
              key,
              limit,
              dimension: selected.dimension,
              kind: "rolling_window",
              durationMs: ResourceAdmissionDurationMs.make(uploadWindowMillis),
            },
      ]);
      yield* admitResource(
        { database: db, nowEpochMs: () => ResourceAdmissionEpochMs.make(current), policies },
        {
          grantId: ResourceAdmissionGrantId.make(`test-exhaust-${newId()}`),
          charges: ResourceAdmissionCharges.make([
            {
              policyKey: key,
              scopeKey: ResourceAdmissionScopeKey.make(selected.scope),
              units: ResourceAdmissionUnits.make(selected.limit),
            },
          ]),
          statements: [],
        }
      );
    }).pipe(Effect.orDie)
  );
