import type { Effect } from "effect";
import type {
  AuditLogEntry,
  AuditPublicationEvidence,
  AuditQuery,
  AuditUnavailable,
} from "./contract";

export type Audit = Readonly<{
  query: (input: AuditQuery) => Effect.Effect<ReadonlyArray<AuditLogEntry>, AuditUnavailable>;
  publications: (
    input: AuditQuery
  ) => Effect.Effect<ReadonlyArray<AuditPublicationEvidence>, AuditUnavailable>;
}>;

export type AuditRetention = Readonly<{
  retain: (
    input: Readonly<{ userId: string; now: number }>
  ) => Effect.Effect<number, AuditUnavailable>;
  sweep: (now: number) => Effect.Effect<number, AuditUnavailable>;
}>;
