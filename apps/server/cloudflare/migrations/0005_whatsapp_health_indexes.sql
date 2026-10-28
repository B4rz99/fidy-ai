CREATE INDEX hosted_delivery_pending_observation
  ON whatsapp_deliveries(proposed_at_ms, user_id, turn_id)
  WHERE kind='hosted' AND state IN ('sending', 'accepted', 'ambiguous');
--> statement-breakpoint

CREATE INDEX hosted_delivery_failed_observation
  ON whatsapp_deliveries(proposed_at_ms)
  WHERE kind='hosted' AND state IN ('rejected', 'unconfirmed');
--> statement-breakpoint

CREATE INDEX hosted_turn_delivery_failure_observation
  ON hosted_turns(terminal_at_ms, user_id, id)
  WHERE status='failed' AND failure_reason='DeliveryFailed';
