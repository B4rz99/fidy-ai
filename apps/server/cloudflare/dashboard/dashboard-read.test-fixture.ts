import type { TransactionSubject } from "../canonical-work/operations";

const digestLength = 32;

export const dashboardSourceCaller = (userId: string): TransactionSubject => ({
  id: "10000000-0000-4000-8000-000000000061",
  userId,
  digest: new Uint8Array(digestLength),
});

/** Valid epoch-zero credentials for isolated source/financial projection fixtures. */
export const seedDashboardSourceCaller = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Promise<void> => {
  const subject = dashboardSourceCaller(userId);
  return db
    .batch([
      db
        .prepare(
          "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,'BCDF-BBB1',?,?,'consumed',0,600000)"
        )
        .bind(subject.id, subject.digest, userId),
      db
        .prepare(
          "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,0,600000,3600000,7776000000)"
        )
        .bind(subject.id, subject.id, userId, subject.digest),
    ])
    .then(() => undefined);
};
