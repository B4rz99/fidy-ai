import { callbackBillingSchema } from "./billing-callback-schema";

const addressId =
  "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))";

export const externalEventSchema = (): ReadonlyArray<string> =>
  [
    ...callbackBillingSchema,
    `CREATE TABLE whatsapp_deliveries(user_id TEXT NOT NULL REFERENCES users(id),family TEXT NOT NULL,operation_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,correlation TEXT NOT NULL,portfolio TEXT NOT NULL,bsuid TEXT NOT NULL,sandbox_phone TEXT,original_deadline_ms INTEGER,
    content_digest TEXT NOT NULL,route_ready INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'staged',started_ms INTEGER,provider_message_id TEXT,delivered_at_ms INTEGER,
    PRIMARY KEY(user_id,family,operation_id),UNIQUE(endpoint,correlation)) STRICT`,
    `CREATE TABLE whatsapp_delivery_status(user_id TEXT NOT NULL,family TEXT NOT NULL,operation_id TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,outcome TEXT NOT NULL,occurred_ms INTEGER NOT NULL,
    FOREIGN KEY(user_id,family,operation_id) REFERENCES whatsapp_deliveries(user_id,family,operation_id),
    PRIMARY KEY(user_id,family,operation_id,provider_message_id,outcome,occurred_ms)) STRICT`,
    `CREATE TABLE forwarded_email_receipts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),deferred_checked_at_ms INTEGER) STRICT`,
    `CREATE TABLE forwarding_addresses(id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    local_part TEXT NOT NULL UNIQUE, issued_at_ms INTEGER NOT NULL) STRICT`,
    `INSERT INTO forwarding_addresses SELECT ${addressId},user_id,lower(hex(randomblob(24))),MIN(occurred_at_ms)
    FROM consent_history WHERE record_type='processing_grant' GROUP BY user_id`,
    `CREATE TRIGGER issue_forwarding_address AFTER INSERT ON consent_history WHEN NEW.record_type='processing_grant' BEGIN
    INSERT INTO forwarding_addresses SELECT ${addressId},NEW.user_id,lower(hex(randomblob(24))),NEW.occurred_at_ms
    WHERE NOT EXISTS(SELECT 1 FROM forwarding_addresses WHERE user_id=NEW.user_id); END`,
  ] as const;
