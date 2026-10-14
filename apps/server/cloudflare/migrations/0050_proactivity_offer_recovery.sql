-- Retain the exact report identity so only never-started expired disclosures can be recovered.
ALTER TABLE proactivity_offer_requests ADD COLUMN delivery_id TEXT;
UPDATE proactivity_offer_requests AS q SET delivery_id=(
 SELECT r.delivery_id FROM proactivity_reports AS r
 WHERE r.user_id=q.user_id
 AND r.role=CASE q.kind WHEN 'budget-threshold' THEN 'budget-offer' ELSE 'reminder-offer' END
 AND r.created_at_ms<=q.materialized_at_ms
 ORDER BY r.created_at_ms DESC,r.delivery_id LIMIT 1
) WHERE q.materialized_at_ms IS NOT NULL;
