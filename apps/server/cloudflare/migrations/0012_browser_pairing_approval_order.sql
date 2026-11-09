CREATE INDEX browser_login_pairings_ready_user ON browser_login_pairings(user_id)
WHERE state = 'ready';
--> statement-breakpoint

CREATE TRIGGER browser_login_pairing_order_immutable BEFORE UPDATE ON browser_login_pairings
WHEN NEW.rowid <> OLD.rowid
BEGIN
  SELECT RAISE(ABORT, 'browser_login_pairing_order_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER browser_login_pairing_supersede AFTER UPDATE OF state ON browser_login_pairings
WHEN OLD.state = 'pending_approval' AND NEW.state = 'ready'
BEGIN
  UPDATE browser_login_pairings SET state = 'invalidated', user_id = NULL
  WHERE state = 'ready' AND user_id = NEW.user_id AND rowid < NEW.rowid;
END;
