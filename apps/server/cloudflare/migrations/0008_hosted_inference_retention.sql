CREATE INDEX resource_admission_hosted_inference_retention
  ON resource_admission_grants (admitted_at_epoch_ms, id)
  WHERE id GLOB 'openai-*' OR id GLOB 'workers-ai-*';
