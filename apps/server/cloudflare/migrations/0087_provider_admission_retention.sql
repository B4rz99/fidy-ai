CREATE INDEX resource_admission_provider_retention
  ON resource_admission_grants (admitted_at_epoch_ms, id)
  WHERE id GLOB 'provider-admission-*';
