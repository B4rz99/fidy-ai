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
    {
      version: 3,
      id: "browser-bootstrap",
      statements: [
        `CREATE TABLE browser_pairings(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,public_code TEXT NOT NULL UNIQUE,
        verifier_digest TEXT NOT NULL CHECK(length(verifier_digest)=64),expires_at_ms INTEGER NOT NULL,
        wrong_attempts INTEGER NOT NULL DEFAULT 0,minimum_poll_seconds INTEGER NOT NULL DEFAULT 5,last_poll_ms INTEGER,user_id TEXT) STRICT`,
        `CREATE TABLE provider_attempts(id TEXT PRIMARY KEY,pairing_id TEXT NOT NULL UNIQUE REFERENCES browser_pairings(id) ON DELETE CASCADE,
        invitation TEXT,provider TEXT NOT NULL,cookie_digest BLOB NOT NULL,nonce TEXT NOT NULL,intent TEXT NOT NULL,disclosure TEXT,accepted_at_ms INTEGER,
        expires_at_ms INTEGER NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,issuer TEXT,subject TEXT,contact_email TEXT) STRICT`,
        `CREATE TABLE provider_routes(issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL,creation_attempt TEXT NOT NULL,established INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(issuer,subject)) STRICT`,
        `CREATE TABLE channel_approvals(id TEXT PRIMARY KEY,pairing_id TEXT NOT NULL UNIQUE REFERENCES browser_pairings(id) ON DELETE CASCADE,user_id TEXT NOT NULL,portfolio TEXT NOT NULL,bsuid TEXT NOT NULL,endpoint TEXT NOT NULL,message TEXT NOT NULL,occurred_ms INTEGER NOT NULL,received_ms INTEGER NOT NULL,UNIQUE(portfolio,message)) STRICT`,
        `CREATE TABLE whatsapp_invitations(id TEXT PRIMARY KEY,portfolio TEXT NOT NULL,bsuid TEXT NOT NULL,endpoint TEXT NOT NULL,message TEXT NOT NULL,phone TEXT,expires_at_ms INTEGER NOT NULL,pairing_id TEXT,review_code TEXT,review_attempt TEXT,review_text TEXT,review_started_ms INTEGER,decision TEXT,decision_message TEXT,confirmed_ms INTEGER, UNIQUE(portfolio,message)) STRICT`,
        "CREATE INDEX whatsapp_invitation_caller ON whatsapp_invitations(portfolio,bsuid,expires_at_ms)",
        "CREATE INDEX whatsapp_invitation_expiry ON whatsapp_invitations(expires_at_ms)",
        "CREATE UNIQUE INDEX whatsapp_invitation_review ON whatsapp_invitations(review_code) WHERE review_code IS NOT NULL",
        `CREATE TABLE whatsapp_routes(portfolio TEXT NOT NULL,bsuid TEXT NOT NULL,user_id TEXT NOT NULL UNIQUE,attempt_id TEXT NOT NULL,established INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(portfolio,bsuid)) STRICT`,
        `CREATE TABLE recovery_routes(code_digest BLOB PRIMARY KEY NOT NULL CHECK(length(code_digest)=32),user_id TEXT NOT NULL UNIQUE,attempt_id TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL) STRICT`,
        `CREATE TABLE bootstrap_admissions(id INTEGER PRIMARY KEY,scope TEXT NOT NULL,expires_at_ms INTEGER NOT NULL) STRICT`,
        "CREATE INDEX bootstrap_admission_scope ON bootstrap_admissions(scope,expires_at_ms)",
        "CREATE INDEX bootstrap_admission_expiry ON bootstrap_admissions(expires_at_ms)",
        "CREATE INDEX pairing_expiry ON browser_pairings(expires_at_ms)",
      ],
    },
  ],
};
