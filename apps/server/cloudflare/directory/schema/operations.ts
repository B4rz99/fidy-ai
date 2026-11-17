import type { StoreHistory } from "../../runtime/sqlite/contract";

const initialDirectorySchema = [
  `CREATE TABLE session_routes (
          token_digest BLOB PRIMARY KEY CHECK(length(token_digest)=32),
          user_id TEXT NOT NULL, session_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
          hard_expires_at_ms INTEGER NOT NULL) STRICT`,
];

export const directoryHistory: StoreHistory = {
  owner: "directory",
  steps: [
    { version: 1, id: "initial-session-routes", statements: initialDirectorySchema },
    {
      version: 2,
      id: "pat-routes",
      statements: [
        `CREATE TABLE pat_routes(short_id TEXT PRIMARY KEY CHECK(length(short_id)=8),user_id TEXT NOT NULL,pat_id TEXT NOT NULL,reservation_id TEXT NOT NULL,expires_at_ms INTEGER NOT NULL) STRICT`,
        `CREATE TABLE unresolved_source_buckets(subject TEXT PRIMARY KEY NOT NULL,virtual_at_ms INTEGER NOT NULL) STRICT`,
        `CREATE INDEX unresolved_source_expiry ON unresolved_source_buckets(virtual_at_ms)`,
      ],
    },
  ],
};
