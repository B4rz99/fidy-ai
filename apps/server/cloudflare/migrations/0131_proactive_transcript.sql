-- Share delivered-message storage without merging InsightEvent and delivery identities.
CREATE TABLE proactive_transcript_entries_next (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 kind TEXT NOT NULL DEFAULT 'insight' CHECK(kind IN ('insight','message')),
 id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 insight_event_id TEXT,
 delivery_id TEXT,
 role TEXT,
 occurred_at_ms INTEGER NOT NULL,
 text TEXT NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 UNIQUE(kind,id),
 UNIQUE(user_id,kind,id),
 UNIQUE(user_id,insight_event_id),
 UNIQUE(user_id,delivery_id),
 CHECK((kind='insight' AND insight_event_id IS NOT NULL AND delivery_id IS NULL AND role IS NULL
   AND expires_at_ms=occurred_at_ms+2592000000)
 OR (kind='message' AND insight_event_id IS NULL AND delivery_id IS NOT NULL AND role IS NOT NULL
   AND role IN ('budget-offer','reminder-offer','recurring-offer','reminder-question'))),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;

INSERT INTO proactive_transcript_entries_next(sequence,id,user_id,insight_event_id,occurred_at_ms,text,expires_at_ms)
SELECT sequence,id,user_id,insight_event_id,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries;

UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='proactive_transcript_entries'),0))
WHERE name='proactive_transcript_entries_next';

INSERT INTO proactive_transcript_entries_next(kind,id,user_id,delivery_id,role,occurred_at_ms,text,expires_at_ms)
SELECT 'message',id,user_id,delivery_id,role,occurred_at_ms,text,expires_at_ms FROM proactive_message_transcript_entries ORDER BY occurred_at_ms,id;

CREATE TABLE proactive_transcript_event_links_next (
 user_id TEXT NOT NULL,
 transcript_id TEXT NOT NULL,
 insight_event_id TEXT NOT NULL,
 transcript_kind TEXT NOT NULL DEFAULT 'insight' CHECK(transcript_kind='insight'),
 PRIMARY KEY(user_id,insight_event_id),
 FOREIGN KEY(user_id,transcript_kind,transcript_id) REFERENCES proactive_transcript_entries_next(user_id,kind,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;

INSERT INTO proactive_transcript_event_links_next(user_id,transcript_id,insight_event_id)
SELECT user_id,transcript_id,insight_event_id FROM proactive_transcript_event_links;

DROP TRIGGER IF EXISTS proactive_transcript_append_only;

DROP TRIGGER IF EXISTS proactive_primary_link;

DROP TRIGGER IF EXISTS proactive_message_transcript_immutable;

DROP TRIGGER IF EXISTS proactive_transcript_retention_guard;

DROP TRIGGER IF EXISTS erasure_fence_proactive_message_transcript_entries_insert;

DROP TRIGGER IF EXISTS erasure_fence_proactive_message_transcript_entries_update;

DROP TRIGGER IF EXISTS erasure_fence_proactive_message_transcript_entries_delete;

DROP TRIGGER IF EXISTS erasure_fence_proactive_transcript_entries_insert;

DROP TRIGGER IF EXISTS erasure_fence_proactive_transcript_entries_update;

DROP TRIGGER IF EXISTS erasure_fence_proactive_transcript_entries_delete;

DROP TRIGGER IF EXISTS erasure_fence_proactive_transcript_event_links_insert;

DROP TRIGGER IF EXISTS erasure_fence_proactive_transcript_event_links_update;

DROP TRIGGER IF EXISTS erasure_fence_proactive_transcript_event_links_delete;

DROP TRIGGER IF EXISTS erasure_preserve_proactive_message_transcript_entries_delete;

DROP TRIGGER IF EXISTS erasure_preserve_proactive_transcript_entries_delete;

DROP TRIGGER IF EXISTS erasure_preserve_proactive_transcript_event_links_delete;

DROP TABLE proactive_transcript_event_links;

DROP TABLE proactive_transcript_entries;

DROP TABLE proactive_message_transcript_entries;

ALTER TABLE proactive_transcript_entries_next RENAME TO proactive_transcript_entries;

ALTER TABLE proactive_transcript_event_links_next RENAME TO proactive_transcript_event_links;

CREATE INDEX proactive_transcript_retention ON proactive_transcript_entries(expires_at_ms,sequence);

CREATE TRIGGER proactive_transcript_append_only BEFORE UPDATE ON proactive_transcript_entries
BEGIN SELECT CASE WHEN OLD.kind='message' THEN RAISE(ABORT,'proactive_message_transcript_immutable') ELSE RAISE(ABORT,'proactive_transcript_append_only') END; END;

CREATE TRIGGER proactive_primary_link AFTER INSERT ON proactive_transcript_entries
WHEN NEW.kind='insight'
BEGIN INSERT INTO proactive_transcript_event_links(user_id,transcript_id,insight_event_id) VALUES(NEW.user_id,NEW.id,NEW.insight_event_id); END;

CREATE TRIGGER proactive_transcript_retention_guard BEFORE DELETE ON proactive_transcript_entries
WHEN OLD.kind='insight' AND (OLD.expires_at_ms > unixepoch('now') * 1000) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='proactive_transcript_entries' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'proactive_transcript_retention_not_due'); END;

CREATE TRIGGER erasure_fence_proactive_transcript_entries_insert BEFORE INSERT ON proactive_transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_entries'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactive_transcript_entries_update BEFORE UPDATE ON proactive_transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_entries'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactive_transcript_entries_delete BEFORE DELETE ON proactive_transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_entries'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactive_transcript_event_links_insert BEFORE INSERT ON proactive_transcript_event_links
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_event_links'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactive_transcript_event_links_update BEFORE UPDATE ON proactive_transcript_event_links
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_event_links'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactive_transcript_event_links_delete BEFORE DELETE ON proactive_transcript_event_links
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_event_links'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_proactive_transcript_entries_delete BEFORE DELETE ON proactive_transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactive_transcript_entries','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'delivery_id',OLD.delivery_id,'role',OLD.role,'sequence',OLD."sequence",'id',OLD."id",'user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id",'occurred_at_ms',OLD."occurred_at_ms",'text',OLD."text",'expires_at_ms',OLD."expires_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_proactive_transcript_event_links_delete BEFORE DELETE ON proactive_transcript_event_links
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactive_transcript_event_links','drain:'||lower(hex(randomblob(16))),json_object('transcript_kind',OLD.transcript_kind,'user_id',OLD."user_id",'transcript_id',OLD."transcript_id",'insight_event_id',OLD."insight_event_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
