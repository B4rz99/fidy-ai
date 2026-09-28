-- Finite, metadata-only minute buckets. Raw TailItem fields never enter D1.
CREATE TABLE operational_event_buckets (
  kind TEXT NOT NULL CHECK (kind IN ('heartbeat', 'tail_overflow', 'worker_exception', 'resource_limit', 'callback_rejection', 'workflow_failure')),
  bucket_ms INTEGER NOT NULL CHECK (bucket_ms >= 0 AND bucket_ms % 60000 = 0),
  count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 1000),
  PRIMARY KEY (kind, bucket_ms)
) STRICT;

-- A submitted canary is not a pass. Only its actual Queue or Workflow execution writes this row.
CREATE TABLE operational_health_view (
  operation TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('healthy', 'attention', 'unavailable')),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0)
) STRICT;

CREATE TABLE operational_canary (
  kind TEXT PRIMARY KEY NOT NULL CHECK (kind IN ('queueExecution', 'workflowExecution')),
  last_succeeded_ms INTEGER NOT NULL CHECK (last_succeeded_ms >= 0)
) STRICT;
