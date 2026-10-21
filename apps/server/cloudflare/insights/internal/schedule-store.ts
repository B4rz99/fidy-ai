import { DateTime } from "effect";
import type { ConsentRecordId } from "../../../src/core/consent/contract";
import type { UserId } from "../../../src/core/identity/contract";
import type { ScheduleId, ScheduleVersion } from "../../../src/core/insights/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";

type Kind = "weekly" | "reminder";
type Scope = Readonly<{ db: D1Database; userId: UserId; kind: Kind }>;
type Snapshot = Readonly<{
  id: ScheduleId;
  userId: UserId;
  version: ScheduleVersion;
}>;

export const prepareActivation = (
  input: Scope &
    Readonly<{
      snapshot: Pick<Snapshot, "id" | "version"> & Readonly<{ nextScheduledAt: DateTime.Utc }>;
      grantId: ConsentRecordId;
      json: string;
    }>
): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare(
      "INSERT INTO schedules(kind,id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id) VALUES (?,?,?,?,1,?,?,?) ON CONFLICT(kind,user_id) DO UPDATE SET version=excluded.version,enabled=1,snapshot_json=excluded.snapshot_json,next_scheduled_at=excluded.next_scheduled_at,consent_grant_id=excluded.consent_grant_id"
    )
    .bind(
      input.kind,
      input.snapshot.id,
      input.userId,
      input.snapshot.version,
      input.json,
      DateTime.formatIso(input.snapshot.nextScheduledAt),
      input.grantId
    ),
  prepareChangedRowAssertion({ db: input.db, scope: `${input.kind}_schedule` }),
  input.db
    .prepare(
      "INSERT INTO schedule_history(record_type,kind,user_id,schedule_id,version,snapshot_json) VALUES ('revision',?,?,?,?,?)"
    )
    .bind(input.kind, input.userId, input.snapshot.id, input.snapshot.version, input.json),
];

export const prepareDisable = (input: Scope): D1PreparedStatement =>
  input.db
    .prepare("UPDATE schedules SET enabled=0 WHERE kind=? AND user_id=?")
    .bind(input.kind, input.userId);

export const prepareAdvance = (
  input: Readonly<{
    db: D1Database;
    snapshot: Snapshot;
    scheduledAt: DateTime.Utc;
    next: DateTime.Utc;
    guard: (statement: OwnedStatement) => D1PreparedStatement;
  }> &
    (
      | Readonly<{ kind: "weekly"; outcome: "generated" | "empty" | "expired" }>
      | Readonly<{ kind: "reminder"; outcome: "generated" | "expired" }>
    )
): ReadonlyArray<D1PreparedStatement> => {
  const { snapshot } = input;
  const completion = prepareChangedRowAssertion({ db: input.db, scope: `${input.kind}_schedule` });
  return [
    input.guard({
      sql: "INSERT INTO schedule_history(record_type,kind,user_id,schedule_id,version,scheduled_at,outcome) SELECT 'execution',?,?,?,?,?,? WHERE 1=1",
      params: [
        input.kind,
        snapshot.userId,
        snapshot.id,
        snapshot.version,
        DateTime.formatIso(input.scheduledAt),
        input.outcome,
      ],
    }),
    completion,
    input.guard({
      sql: "UPDATE schedules SET next_scheduled_at=? WHERE kind=? AND user_id=? AND id=?",
      params: [DateTime.formatIso(input.next), input.kind, snapshot.userId, snapshot.id],
    }),
    completion,
  ];
};
