import { providerAllowanceSchema } from "../../resource-admission/contract";
import {
  cleanupBarrierColumns,
  deletionWitness,
  erasureBarrierSchema,
} from "../../erasure-store/operations";
import { publicDirectorySchema } from "./credential-schema";
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
    {
      version: 6,
      id: "cli-and-mcp-credentials",
      statements: [
        ...publicDirectorySchema(),
        `CREATE TABLE pat_bootstrap(id TEXT PRIMARY KEY,public_code TEXT NOT NULL UNIQUE,proof_digest TEXT NOT NULL CHECK(length(proof_digest)=64),
      recipient_label TEXT NOT NULL,scopes_json TEXT NOT NULL,lifetime_days INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,wrong_attempts INTEGER NOT NULL DEFAULT 0,last_poll_at_ms INTEGER,
      minimum_poll_seconds INTEGER NOT NULL DEFAULT 5,user_id TEXT) STRICT`,
        "CREATE TABLE pat_source_windows(source TEXT PRIMARY KEY,ends INTEGER NOT NULL,used INTEGER NOT NULL) STRICT",
        "CREATE INDEX pat_route_expiry ON pat_routes(expires_at_ms)",
        "CREATE INDEX pat_source_expiry ON pat_source_windows(ends)",
        "CREATE TABLE pat_reservation_context(short_id TEXT PRIMARY KEY REFERENCES pat_routes(short_id) ON DELETE CASCADE,context TEXT NOT NULL) STRICT",
        "CREATE UNIQUE INDEX pat_route_operation ON pat_routes(user_id,reservation_id)",
        "CREATE INDEX pat_bootstrap_expiry ON pat_bootstrap(expires_at_ms)",
      ],
    },
    {
      version: 7,
      id: "login-email-allowance",
      statements: [
        "ALTER TABLE browser_pairings ADD COLUMN email_handoff TEXT",
        "CREATE TABLE login_email_window(singleton INTEGER PRIMARY KEY CHECK(singleton=1),reset_at_ms INTEGER NOT NULL,used INTEGER NOT NULL CHECK(used BETWEEN 1 AND 1000)) STRICT",
      ],
    },
    {
      version: 8,
      id: "forwarded-email-capacity",
      statements: [
        "CREATE TABLE email_capacity_slots(slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 10000),generation INTEGER NOT NULL,receipt TEXT,expires_at_ms INTEGER,state TEXT CHECK(state IN ('outstanding','retained'))) STRICT",
        "CREATE INDEX email_capacity_outstanding ON email_capacity_slots(state,expires_at_ms)",
        "CREATE INDEX email_capacity_expiry ON email_capacity_slots(expires_at_ms) WHERE receipt IS NOT NULL",
      ],
    },
    { version: 9, id: "shared-provider-allowances", statements: providerAllowanceSchema },
    {
      version: 10,
      id: "user-erasure-barrier",
      statements: [
        erasureBarrierSchema,
        "ALTER TABLE identity_replacements ADD COLUMN retry_at_ms INTEGER",
        "CREATE VIEW identity_replacement_checks AS SELECT r.id,coalesce(r.retry_at_ms,CASE WHEN b.user_id IS NULL THEN r.expires_at_ms ELSE 0 END) AS due_ms FROM identity_replacements r LEFT JOIN erasure_barriers b ON b.user_id=r.user_id WHERE r.state='reserved'",

        "ALTER TABLE provider_attempts ADD COLUMN erasure_check_ms INTEGER NOT NULL DEFAULT 0",
        "CREATE VIEW fenced_provider_handoffs AS SELECT a.id,a.erasure_check_ms FROM erasure_barriers e JOIN browser_pairings p ON p.user_id=e.user_id JOIN provider_attempts a ON a.pairing_id=p.id WHERE a.state='bound' AND a.acknowledged=0",
        "CREATE INDEX bound_pairing_user ON browser_pairings(user_id) WHERE user_id IS NOT NULL",

        ...[
          "session_routes",
          "pat_routes",
          "provider_routes",
          "whatsapp_routes",
          "recovery_routes",
          "channel_approvals",
          "support_handoffs",
          "verified_email_routes",
          "identity_replacements",
          "external_event_routes",
          "oauth_routes",
        ].map(
          (table) =>
            `CREATE TRIGGER fence_${table}_insert BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM erasure_barriers WHERE user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'user_erasure_fence'); END`
        ),
        "CREATE TRIGGER fence_recovery_rotation BEFORE INSERT ON recovery_rotations WHEN NEW.state='reserved' AND EXISTS(SELECT 1 FROM erasure_barriers WHERE user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'user_erasure_fence'); END",
        ...["browser_pairings", "pat_bootstrap", "oauth_review_requests"].map(
          (table) =>
            `CREATE TRIGGER fence_${table}_binding BEFORE UPDATE ON ${table} WHEN EXISTS(SELECT 1 FROM erasure_barriers WHERE user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'user_erasure_fence'); END`
        ),
      ],
    },
    {
      version: 11,
      id: "erasure-cleanup-receipts",
      statements: [
        ...cleanupBarrierColumns,
        "CREATE INDEX erasure_wa_admission ON whatsapp_routes(('wa:'||length(portfolio)||':'||portfolio||bsuid))",
        "CREATE INDEX erasure_poll_admission ON browser_pairings(('poll:'||verifier_digest))",
        "CREATE INDEX erasure_invitation_pairing ON whatsapp_invitations(pairing_id)",
        deletionWitness({
          table: "bootstrap_admissions",
          deadline: "OLD.expires_at_ms",
          owner:
            "coalesce((SELECT user_id FROM whatsapp_routes WHERE OLD.scope='wa:'||length(portfolio)||':'||portfolio||bsuid),(SELECT user_id FROM browser_pairings WHERE OLD.scope='poll:'||verifier_digest))",
        }),

        ...[
          "browser_pairings",
          "oauth_routes",
          "oauth_review_requests",
          "pat_bootstrap",
          "pat_routes",
          "identity_replacements",
          "recovery_rotations",
        ].map((table) =>
          deletionWitness({ table, deadline: "OLD.expires_at_ms", owner: "OLD.user_id" })
        ),
        deletionWitness({
          table: "session_routes",
          deadline: "OLD.hard_expires_at_ms",
          owner: "OLD.user_id",
        }),
        deletionWitness({
          table: "support_handoffs",
          deadline: "OLD.operator_expires_ms",
          owner: "OLD.user_id",
        }),
        ...["recovery_routes", "external_event_routes", "channel_approvals"].map((table) =>
          deletionWitness({ table, deadline: "0", owner: "OLD.user_id" })
        ),
        deletionWitness({
          table: "whatsapp_invitations",
          deadline: "OLD.expires_at_ms+86400000",
          owner:
            "coalesce((SELECT user_id FROM browser_pairings WHERE id=OLD.pairing_id),(SELECT user_id FROM whatsapp_routes WHERE portfolio=OLD.portfolio AND bsuid=OLD.bsuid))",
        }),
      ],
    },
    {
      version: 12,
      id: "retained-media-capacity",
      statements: [
        "CREATE TABLE media_capacity_slots(slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 2500),generation INTEGER NOT NULL,receipt TEXT,expires_at_ms INTEGER,state TEXT CHECK(state IN ('outstanding','retained'))) STRICT",
        "CREATE INDEX media_capacity_expiry ON media_capacity_slots(expires_at_ms) WHERE receipt IS NOT NULL",
      ],
    },
    {
      version: 13,
      id: "rejected-invitation-send",
      statements: [
        "ALTER TABLE whatsapp_invitations ADD COLUMN send_rejected INTEGER NOT NULL DEFAULT 0 CHECK(send_rejected IN(0,1))",
      ],
    },
    {
      version: 14,
      id: "oauth-lease-source",
      statements: [
        "ALTER TABLE oauth_leases ADD COLUMN source TEXT",
        "CREATE INDEX oauth_lease_source ON oauth_leases(source,expires_at_ms)",
      ],
    },
  ],
};
