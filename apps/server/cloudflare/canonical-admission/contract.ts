import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Context, Data, type Effect, type Option, type Schema } from "effect";
import type { OperationAccessCaller } from "../../src/shell/canonical-policy/contract";
import type { AccessTier } from "../../src/core/access-tier/contract";

export const CurrentSuggestionCaller = Context.Reference<
  Readonly<{ accessCaller: OperationAccessCaller; tier: AccessTier }>
>("@fidy/cloudflare/CurrentSuggestionCaller", {
  defaultValue: () => ({ accessCaller: { _tag: "PAT", capabilities: [] }, tier: "free" }),
});

export class CanonicalAdmissionUnavailable extends Data.TaggedError(
  "CanonicalAdmissionUnavailable"
)<{ readonly cause: unknown }> {}

export const canonicalRequestProtection = {
  intervalMs: 100,
  burst: 10,
  concurrency: 2,
  leaseMs: 90000,
  retryAfterSeconds: 1,
} as const;

export type LocalMutationResult = Readonly<{
  status: number;
  outcome: "success" | "validation_failed" | "not_found" | "resource_limit";
  body: Schema.Json;
}>;

export type LocalReviewFacts = { effect: string; revision: string };
export type LocalMutationPlan = Readonly<{
  review: Option.Option<
    Effect.Effect<LocalReviewFacts, CanonicalAdmissionUnavailable, SqliteClient>
  >;
  premises: ReadonlyArray<string>;
  targets: ReadonlyArray<string>;
  removedTarget: Option.Option<string>;
  commit: Effect.Effect<LocalMutationResult, CanonicalAdmissionUnavailable, SqliteClient>;
}>;
export type LocalMutationPreparation = LocalMutationResult | LocalMutationPlan;
