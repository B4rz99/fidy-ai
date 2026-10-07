ALTER TABLE proactivity_consent_offers ADD COLUMN replaces_offer_id TEXT;
CREATE UNIQUE INDEX proactivity_offer_replacement_unique ON proactivity_consent_offers(replaces_offer_id) WHERE replaces_offer_id IS NOT NULL;
CREATE TRIGGER proactivity_offer_replacement_immutable BEFORE UPDATE ON proactivity_consent_offers
 WHEN NEW.replaces_offer_id IS NOT OLD.replaces_offer_id
 BEGIN SELECT RAISE(ABORT,'consent_offer_replacement_immutable'); END;
