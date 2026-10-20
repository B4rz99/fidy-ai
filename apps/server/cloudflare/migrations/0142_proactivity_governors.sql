DROP TRIGGER reminder_governor_attention_reset;

DROP TRIGGER erasure_fence_reminder_delivery_receipts_insert;

DROP TRIGGER erasure_fence_reminder_delivery_receipts_update;

DROP TRIGGER erasure_fence_reminder_delivery_receipts_delete;

DROP TRIGGER erasure_fence_reminder_governors_insert;

DROP TRIGGER erasure_fence_reminder_governors_update;

DROP TRIGGER erasure_fence_reminder_governors_delete;

DROP TRIGGER erasure_fence_weekly_governor_deliveries_insert;

DROP TRIGGER erasure_fence_weekly_governor_deliveries_update;

DROP TRIGGER erasure_fence_weekly_governor_deliveries_delete;

DROP TRIGGER erasure_fence_weekly_governors_insert;

DROP TRIGGER erasure_fence_weekly_governors_update;

DROP TRIGGER erasure_fence_weekly_governors_delete;

DROP TRIGGER erasure_preserve_reminder_delivery_receipts_delete;

DROP TRIGGER erasure_preserve_reminder_governors_delete;

DROP TRIGGER erasure_preserve_weekly_governor_deliveries_delete;

DROP TRIGGER erasure_preserve_weekly_governors_delete;

CREATE TABLE proactivity_governors (
 kind TEXT NOT NULL CHECK(kind IN ('weekly','reminder')),user_id TEXT NOT NULL REFERENCES users(id),
 unanswered INTEGER NOT NULL DEFAULT 0 CHECK(unanswered BETWEEN 0 AND 200),last_reply_at_ms INTEGER NOT NULL DEFAULT 0,
 question_needed INTEGER NOT NULL DEFAULT 0 CHECK(question_needed IN (0,1)),question_delivered INTEGER NOT NULL DEFAULT 0 CHECK(question_delivered IN (0,1)),
 question_delivered_at_ms INTEGER,question_event_id TEXT,paused_at_ms INTEGER,notice_session_id TEXT,notice_turn_id TEXT,
 notice_completed INTEGER NOT NULL DEFAULT 0 CHECK(notice_completed IN (0,1)),standing_json TEXT CHECK(standing_json IS NULL OR json_valid(standing_json)),question_id TEXT,
 PRIMARY KEY(kind,user_id),
 CHECK((kind='weekly' AND standing_json IS NULL AND question_id IS NULL AND (question_delivered=0)=(question_delivered_at_ms IS NULL) AND question_delivered<=question_needed AND (question_needed=0 OR question_event_id IS NOT NULL))
 OR(kind='reminder' AND standing_json IS NOT NULL AND unanswered=0 AND question_needed=0 AND question_delivered=0 AND question_event_id IS NULL AND paused_at_ms IS NULL AND notice_session_id IS NULL))
) STRICT;

CREATE TABLE governor_delivery_receipts (
 kind TEXT NOT NULL CHECK(kind IN ('weekly','reminder')),user_id TEXT NOT NULL REFERENCES users(id),insight_event_id TEXT,delivery_id TEXT,
 receipt_id TEXT GENERATED ALWAYS AS(coalesce(insight_event_id,delivery_id)) VIRTUAL NOT NULL,
 UNIQUE(kind,user_id,receipt_id),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id),
 CHECK((kind='weekly' AND insight_event_id IS NOT NULL AND delivery_id IS NULL) OR(kind='reminder' AND insight_event_id IS NULL AND delivery_id IS NOT NULL))
) STRICT;

INSERT INTO proactivity_governors(kind,user_id,unanswered,last_reply_at_ms,question_needed,question_delivered,question_delivered_at_ms,question_event_id,paused_at_ms,notice_session_id,notice_turn_id,notice_completed) SELECT 'weekly',user_id,unanswered,last_reply_at_ms,question_needed,question_delivered,question_delivered_at_ms,question_event_id,paused_at_ms,notice_session_id,notice_turn_id,notice_completed FROM weekly_governors;

DROP TABLE weekly_governors;

INSERT INTO proactivity_governors(kind,user_id,standing_json,last_reply_at_ms,question_id,question_delivered_at_ms,notice_turn_id,notice_completed) SELECT 'reminder',user_id,standing_json,last_reply_at_ms,question_id,question_delivered_at_ms,notice_turn_id,notice_completed FROM reminder_governors;

DROP TABLE reminder_governors;

INSERT INTO governor_delivery_receipts(kind,user_id,insight_event_id) SELECT 'weekly',user_id,insight_event_id FROM weekly_governor_deliveries;

DROP TABLE weekly_governor_deliveries;

INSERT INTO governor_delivery_receipts(kind,user_id,delivery_id) SELECT 'reminder',user_id,delivery_id FROM reminder_delivery_receipts;

DROP TABLE reminder_delivery_receipts;

CREATE TRIGGER reminder_governor_attention_reset AFTER UPDATE OF standing_json ON proactivity_governors
WHEN NEW.kind='reminder' AND (json_extract(NEW.standing_json,'$._tag')='Attentive' AND json_extract(NEW.standing_json,'$.unanswered')=0
)
BEGIN
 UPDATE proactivity_governors AS reminder_governors SET question_id=NULL,question_delivered_at_ms=NULL,notice_turn_id=NULL,notice_completed=0 WHERE kind='reminder' AND user_id=NEW.user_id;
END;

CREATE TRIGGER erasure_fence_reminder_delivery_receipts_insert BEFORE INSERT ON governor_delivery_receipts
WHEN NEW.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_delivery_receipts'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_reminder_delivery_receipts_update BEFORE UPDATE ON governor_delivery_receipts
WHEN NEW.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_delivery_receipts'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_reminder_delivery_receipts_delete BEFORE DELETE ON governor_delivery_receipts
WHEN OLD.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_delivery_receipts'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_reminder_governors_insert BEFORE INSERT ON proactivity_governors
WHEN NEW.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_reminder_governors_update BEFORE UPDATE ON proactivity_governors
WHEN NEW.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_reminder_governors_delete BEFORE DELETE ON proactivity_governors
WHEN OLD.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_governor_deliveries_insert BEFORE INSERT ON governor_delivery_receipts
WHEN NEW.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_deliveries'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_governor_deliveries_update BEFORE UPDATE ON governor_delivery_receipts
WHEN NEW.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_deliveries'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_governor_deliveries_delete BEFORE DELETE ON governor_delivery_receipts
WHEN OLD.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_deliveries'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_governors_insert BEFORE INSERT ON proactivity_governors
WHEN NEW.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_governors_update BEFORE UPDATE ON proactivity_governors
WHEN NEW.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_governors_delete BEFORE DELETE ON proactivity_governors
WHEN OLD.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_reminder_delivery_receipts_delete BEFORE DELETE ON governor_delivery_receipts
WHEN OLD.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_delivery_receipts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'delivery_id',OLD."delivery_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_reminder_governors_delete BEFORE DELETE ON proactivity_governors
WHEN OLD.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_governors','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'standing_json',OLD."standing_json",'last_reply_at_ms',OLD."last_reply_at_ms",'question_id',OLD."question_id",'question_delivered_at_ms',OLD."question_delivered_at_ms",'notice_turn_id',OLD."notice_turn_id",'notice_completed',OLD."notice_completed")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_governor_deliveries_delete BEFORE DELETE ON governor_delivery_receipts
WHEN OLD.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_governor_deliveries','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_governors_delete BEFORE DELETE ON proactivity_governors
WHEN OLD.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_governors','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'unanswered',OLD."unanswered",'last_reply_at_ms',OLD."last_reply_at_ms",'question_needed',OLD."question_needed",'question_delivered',OLD."question_delivered",'question_delivered_at_ms',OLD."question_delivered_at_ms",'question_event_id',OLD."question_event_id",'paused_at_ms',OLD."paused_at_ms",'notice_session_id',OLD."notice_session_id",'notice_turn_id',OLD."notice_turn_id",'notice_completed',OLD."notice_completed")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER proactivity_governors_kind_immutable BEFORE UPDATE OF kind ON proactivity_governors WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'governor_kind_immutable'); END;

CREATE TRIGGER governor_delivery_receipts_kind_immutable BEFORE UPDATE OF kind ON governor_delivery_receipts WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'governor_kind_immutable'); END;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_governors',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_governors';
