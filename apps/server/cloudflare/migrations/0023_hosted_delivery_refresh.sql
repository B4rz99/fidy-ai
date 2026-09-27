-- A browser that received a Processing response can recover a proposal without persisting
-- a bearer receipt in D1. Only the digest may be rotated; the answer and expiry stay exact.
DROP TRIGGER hosted_delivery_proposals_no_update;
CREATE TRIGGER hosted_delivery_proposals_no_update BEFORE UPDATE ON hosted_delivery_proposals
WHEN NEW.turn_id <> OLD.turn_id OR NEW.user_id <> OLD.user_id OR NEW.text <> OLD.text
  OR NEW.proposed_at_ms <> OLD.proposed_at_ms
  OR NOT EXISTS (SELECT 1 FROM hosted_turns WHERE id = OLD.turn_id
    AND user_id = OLD.user_id AND status = 'pending')
BEGIN SELECT RAISE(ABORT, 'hosted_delivery_immutable'); END;
