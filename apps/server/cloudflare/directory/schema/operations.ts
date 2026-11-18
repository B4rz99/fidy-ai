import { externalRoutesSchema } from "./external-events";
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
    { version: 4, id: "external-event-routes", statements: externalRoutesSchema() },
    {
      version: 5,
      id: "identity-replacement-reservations",
      statements: [
        "ALTER TABLE recovery_routes RENAME TO bootstrap_recovery_routes",
        "CREATE TABLE recovery_routes(code_digest BLOB PRIMARY KEY NOT NULL CHECK(length(code_digest)=32),user_id TEXT NOT NULL,attempt_id TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL) STRICT",
        "INSERT INTO recovery_routes SELECT * FROM bootstrap_recovery_routes",
        "DROP TABLE bootstrap_recovery_routes",
        "CREATE UNIQUE INDEX initial_recovery_route ON recovery_routes(user_id) WHERE revision=1",
        "CREATE INDEX recovery_route_owner ON recovery_routes(user_id)",
        "CREATE TABLE recovery_rotations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,prior_digest TEXT NOT NULL,next_digest TEXT NOT NULL,prior_reservation TEXT,revision INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','committed','cancelled'))) STRICT",
        "CREATE INDEX recovery_rotation_expiry ON recovery_rotations(expires_at_ms) WHERE state<>'reserved'",
        "CREATE TABLE support_recovery_admissions(id INTEGER PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,admitted_at_ms INTEGER NOT NULL) STRICT",
        "CREATE TABLE support_handoffs(id TEXT PRIMARY KEY,pairing_id TEXT NOT NULL UNIQUE REFERENCES browser_pairings(id) ON DELETE CASCADE,user_id TEXT NOT NULL,credential_digest TEXT NOT NULL,revision INTEGER NOT NULL,operator_issuer TEXT NOT NULL,operator_subject TEXT NOT NULL,operator_issued_ms INTEGER NOT NULL,operator_expires_ms INTEGER NOT NULL) STRICT",
        "ALTER TABLE whatsapp_routes RENAME TO prior_whatsapp_routes",
        "CREATE TABLE whatsapp_routes(portfolio TEXT NOT NULL,bsuid TEXT NOT NULL,user_id TEXT NOT NULL,attempt_id TEXT NOT NULL,established INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(portfolio,bsuid)) STRICT",
        "INSERT INTO whatsapp_routes(portfolio,bsuid,user_id,attempt_id,established) SELECT * FROM prior_whatsapp_routes",
        "DROP TABLE prior_whatsapp_routes",
        "CREATE INDEX whatsapp_route_owner ON whatsapp_routes(user_id)",
        "CREATE TABLE verified_email_routes(normalized_address TEXT PRIMARY KEY,user_id TEXT NOT NULL,reservation_id TEXT NOT NULL,revision INTEGER NOT NULL) STRICT",
        "CREATE INDEX verified_email_route_owner ON verified_email_routes(user_id)",
        "CREATE TABLE identity_replacements(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,prior_key TEXT NOT NULL,next_key TEXT NOT NULL,occurred_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,expected_user TEXT,user_id TEXT NOT NULL,revision INTEGER NOT NULL,prior_reservation TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','committed','cancelled'))) STRICT",
        "CREATE INDEX replacement_deadline ON identity_replacements(expires_at_ms)",
        "CREATE INDEX session_route_expiry ON session_routes(hard_expires_at_ms)",
      ],
    },
  ],
};
