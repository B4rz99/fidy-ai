-- Authenticated caller phone evidence is used only by the configured sandbox endpoint.
-- It follows the existing bounded retention and deletion of its exact inbound Turn.
ALTER TABLE hosted_whatsapp_inbound ADD COLUMN sandbox_phone TEXT;
