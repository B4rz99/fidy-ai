ALTER TABLE connection_grants ADD COLUMN cleanup_after_ms INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_after_ms>=0);
--> statement-breakpoint
ALTER TABLE connection_grants ADD COLUMN cleanup_claim TEXT CHECK(cleanup_claim IS NULL OR length(cleanup_claim)=36);
--> statement-breakpoint
ALTER TABLE connection_grants ADD COLUMN cleaned_at_ms INTEGER CHECK(cleaned_at_ms IS NULL OR (state='cleanup_required' AND envelope IS NULL AND expires_at_ms IS NULL));
--> statement-breakpoint
ALTER TABLE connection_grants ADD COLUMN cleanup_access_seen INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_access_seen IN (0,1));
--> statement-breakpoint
ALTER TABLE connection_grants ADD COLUMN cleanup_refresh_seen INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_refresh_seen IN (0,1));
--> statement-breakpoint
DROP TRIGGER connection_grant_transition;
--> statement-breakpoint
CREATE TRIGGER connection_grant_transition BEFORE UPDATE ON connection_grants
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.claimed_at_ms IS NOT OLD.claimed_at_ms
 OR NOT ((OLD.state='claimed' AND NEW.state IN ('quarantined','cleanup_required'))
  OR (OLD.state='quarantined' AND NEW.state IN ('active','cleanup_required'))
  OR (OLD.state='active' AND NEW.state='cleanup_required')
  OR (OLD.state='cleanup_required' AND NEW.state='cleanup_required'))
 OR NEW.cleanup_access_seen<OLD.cleanup_access_seen OR NEW.cleanup_refresh_seen<OLD.cleanup_refresh_seen
 OR ((NEW.cleanup_access_seen IS NOT OLD.cleanup_access_seen OR NEW.cleanup_refresh_seen IS NOT OLD.cleanup_refresh_seen)
  AND NOT (OLD.state='cleanup_required' AND OLD.cleanup_claim IS NOT NULL AND OLD.cleanup_claim IS NEW.cleanup_claim AND OLD.cleaned_at_ms IS NULL))
 OR (OLD.envelope IS NOT NULL AND (NEW.envelope IS NOT OLD.envelope OR NEW.expires_at_ms IS NOT OLD.expires_at_ms)
  AND NOT (OLD.state='cleanup_required' AND NEW.state='cleanup_required' AND OLD.cleaned_at_ms IS NULL AND NEW.cleaned_at_ms IS NOT NULL AND NEW.envelope IS NULL AND NEW.expires_at_ms IS NULL))
 OR (OLD.cleaned_at_ms IS NOT NULL AND (NEW.cleaned_at_ms IS NOT OLD.cleaned_at_ms OR NEW.envelope IS NOT NULL OR NEW.expires_at_ms IS NOT NULL))
 OR (NEW.cleaned_at_ms IS NOT OLD.cleaned_at_ms AND NOT (OLD.state='cleanup_required' AND OLD.envelope IS NOT NULL AND OLD.cleanup_claim IS NOT NULL AND NEW.cleaned_at_ms IS NOT NULL AND NEW.envelope IS NULL AND NEW.expires_at_ms IS NULL))
BEGIN SELECT RAISE(ABORT,'connection_grant_transition'); END;
