import type { Effect } from "effect";
import type {
  AuditLogEntry,
  AuditPublicationEvidence,
  AuditQuery,
  AuditUnavailable,
} from "./contract";
import { queryEvidence, queryPublications } from "~/shell/audit/internal/query";
import { retainEvidence, sweepEvidence } from "~/shell/audit/internal/retention";

export type Audit = Readonly<{
  query: (input: AuditQuery) => Effect.Effect<ReadonlyArray<AuditLogEntry>, AuditUnavailable>;
  publications: (
    input: AuditQuery
  ) => Effect.Effect<ReadonlyArray<AuditPublicationEvidence>, AuditUnavailable>;
}>;

export const makeAudit = ({ database }: Readonly<{ database: D1Database }>): Audit => ({
  query: (input) => queryEvidence({ database, input }),
  publications: (input) => queryPublications({ database, input }),
});

export type AuditRetention = Readonly<{
  retain: (
    input: Readonly<{ userId: string; now: number }>
  ) => Effect.Effect<number, AuditUnavailable>;
  sweep: (now: number) => Effect.Effect<number, AuditUnavailable>;
}>;

export const makeAuditRetention = ({
  database,
}: Readonly<{ database: D1Database }>): AuditRetention => ({
  retain: (input) => retainEvidence({ database, input }),
  sweep: (now) => sweepEvidence({ database, now }),
});
