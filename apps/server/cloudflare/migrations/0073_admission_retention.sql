-- Exact owner prefixes preserve BINARY identity semantics. Each covering index seeks directly
-- to that owner's expired grants in sweep order, without scanning active or foreign evidence.
CREATE INDEX resource_admission_ai_retention
  ON resource_admission_grants (admitted_at_epoch_ms, id)
  WHERE id GLOB 'workers-ai-*';

CREATE INDEX resource_admission_enrollment_retention
  ON resource_admission_grants (admitted_at_epoch_ms, id)
  WHERE id GLOB 'card-preparation-attempt-*';

CREATE INDEX resource_admission_upload_retention
  ON resource_admission_grants (admitted_at_epoch_ms, id)
  WHERE id GLOB 'ingestion-upload-*';
