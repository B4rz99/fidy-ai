import { Option, Schema } from "effect";
import { newId } from "../../secret-material/operations";

const minuteMs = 60_000;
const hourMs = 3_600_000;
const maximumOperatorMinute = 5;
const maximumOperatorHour = 20;
const maximumGlobalMinute = 20;
const maximumGlobalHour = 100;
const AdmissionResult = Schema.Struct({ meta: Schema.Struct({ changes: Schema.Int }) });

/** Count every admitted verified invocation before decoding; denied traffic retains no proof or body. */
export const admitOperator = ({
  db,
  operator,
  now,
}: Readonly<{
  db: D1Database;
  operator: Readonly<{ issuer: string; subject: string }>;
  now: number;
}>): Promise<"allowed" | "limited" | "unavailable"> =>
  db
    .batch([
      db
        .prepare("DELETE FROM support_recovery_admissions WHERE admitted_at_ms <= ?")
        .bind(now - hourMs),
      db
        .prepare(`INSERT INTO support_recovery_admissions (id,operator_issuer,operator_subject,admitted_at_ms)
      SELECT ?,?,?,? WHERE
      (SELECT count(*) FROM support_recovery_admissions WHERE operator_issuer=? AND operator_subject=? AND admitted_at_ms>?) < ?
      AND (SELECT count(*) FROM support_recovery_admissions WHERE operator_issuer=? AND operator_subject=?) < ?
      AND (SELECT count(*) FROM support_recovery_admissions WHERE admitted_at_ms>?) < ?
      AND (SELECT count(*) FROM support_recovery_admissions) < ?`)
        .bind(
          newId(),
          operator.issuer,
          operator.subject,
          now,
          operator.issuer,
          operator.subject,
          now - minuteMs,
          maximumOperatorMinute,
          operator.issuer,
          operator.subject,
          maximumOperatorHour,
          now - minuteMs,
          maximumGlobalMinute,
          maximumGlobalHour
        ),
    ])
    .then((results) => {
      const admission = Schema.decodeUnknownOption(AdmissionResult)(results[1]);
      if (Option.isNone(admission)) return "unavailable";
      return admission.value.meta.changes === 1 ? "allowed" : "limited";
    });
