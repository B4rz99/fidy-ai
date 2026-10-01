import type { Effect } from "effect";
import type {
  AuditLogEntry,
  AuditPublicationEvidence,
  AuditQuery,
  AuditUnavailable,
} from "./contract";
import { queryEvidence, queryPublications } from "~/shell/audit/internal/query";
import { retainEvidence, sweepEvidence } from "~/shell/audit/internal/retention";

/** The private evidence observer. Callers must supply the authenticated stable User, never an object id. */
export type Audit = Readonly<{
  query: (input: AuditQuery) => Effect.Effect<ReadonlyArray<AuditLogEntry>, AuditUnavailable>;
  publications: (
    input: AuditQuery
  ) => Effect.Effect<ReadonlyArray<AuditPublicationEvidence>, AuditUnavailable>;
}>;

/** Binds Audit to authoritative D1. It grants neither subject resolution nor an ordinary rewrite/delete capability. */
export const makeAudit = ({ database }: Readonly<{ database: D1Database }>): Audit => ({
  query: (input) => queryEvidence({ database, input }),
  publications: (input) => queryPublications({ database, input }),
});

/** Policy-bound maintenance authority, assembled separately from ordinary canonical-call recording. */
export type AuditRetention = Readonly<{
  retain: (
    input: Readonly<{ userId: string; now: number }>
  ) => Effect.Effect<number, AuditUnavailable>;
  sweep: (now: number) => Effect.Effect<number, AuditUnavailable>;
}>;

/**
 * Builds the dedicated retention path: remove only evidence strictly older than 365 days,
 * at most 64 rows per projection and eight subjects per sweep. A failed batch removes nothing
 * and leaves no deletion permit. Cutoffs and storage projections are never caller-selected.
 */
export const makeAuditRetention = ({
  database,
}: Readonly<{ database: D1Database }>): AuditRetention => ({
  retain: (input) => retainEvidence({ database, input }),
  sweep: (now) => sweepEvidence({ database, now }),
});
