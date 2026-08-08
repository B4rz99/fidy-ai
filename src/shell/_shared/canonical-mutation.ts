import { type Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/**
 * Reusable implementation of a canonical mutation. Individual operations and atomic batches call
 * the same implementation inside a caller-owned PostgreSQL transaction. The caller establishes
 * authorization and matching User context and owns commit or rollback.
 */
export type CanonicalMutationImplementation<Input, Output, Failure, Requirements = never> = (
  input: Input
) => Effect.Effect<Output, Failure, Requirements | SqlClient.SqlClient>;
