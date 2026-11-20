import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

export const noLaterReadyPairing = ({
  userId,
  candidate,
  current,
}: Readonly<{
  userId: OwnedStatement;
  candidate: "p" | "browser_login_pairings";
  current: number;
}>): OwnedStatement => ({
  sql: `NOT EXISTS (SELECT 1 FROM browser_login_pairings AS ready
    WHERE ready.state = 'ready' AND ready.user_id = ${userId.sql}
      AND ready.expires_at_ms > ? AND ready.rowid >= ${candidate}.rowid)`,
  params: [...userId.params, current],
});
