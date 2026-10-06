ALTER TABLE reminder_governors ADD COLUMN question_id TEXT;
ALTER TABLE reminder_governors ADD COLUMN question_delivered_at_ms INTEGER;
ALTER TABLE reminder_governors ADD COLUMN notice_turn_id TEXT;
ALTER TABLE reminder_governors ADD COLUMN notice_completed INTEGER NOT NULL DEFAULT 0 CHECK(notice_completed IN (0,1));
CREATE TRIGGER reminder_governor_attention_reset AFTER UPDATE OF standing_json ON reminder_governors
WHEN json_extract(NEW.standing_json,'$._tag')='Attentive' AND json_extract(NEW.standing_json,'$.unanswered')=0
BEGIN
 UPDATE reminder_governors SET question_id=NULL,question_delivered_at_ms=NULL,notice_turn_id=NULL,notice_completed=0 WHERE user_id=NEW.user_id;
END;
CREATE TABLE reminder_delivery_receipts (
 user_id TEXT NOT NULL REFERENCES users(id),
 delivery_id TEXT NOT NULL,
 PRIMARY KEY(user_id,delivery_id)
) STRICT;
CREATE TABLE reminder_control_receipts (
 user_id TEXT NOT NULL REFERENCES users(id),
 message_id TEXT NOT NULL,
 choice TEXT NOT NULL,
 PRIMARY KEY(user_id,message_id)
) STRICT;
