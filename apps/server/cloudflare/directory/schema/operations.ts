import type { StoreHistory } from "../../runtime/sqlite/contract";

const initialDirectorySchema = [
  `CREATE TABLE session_routes (
          token_digest BLOB PRIMARY KEY CHECK(length(token_digest)=32),
          user_id TEXT NOT NULL, session_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
          hard_expires_at_ms INTEGER NOT NULL) STRICT`,
];

export const directoryHistory: StoreHistory = {
  owner: "directory",
  steps: [{ version: 1, id: "initial-session-routes", statements: initialDirectorySchema }],
};
