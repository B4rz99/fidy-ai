import { Data, Effect } from "effect";
import { sweepExpiredWorkersAiAdmission as expireAdmission } from "./internal/admission-retention";

/** Workers AI admission retention failed without exposing database or inference evidence. */
export class WorkersAiAdmissionUnavailable extends Data.TaggedError(
  "WorkersAiAdmissionUnavailable"
) {}

/** Reclaim bounded Workers AI admission evidence only after its one-day horizon and live spend windows expire. now is the decision instant in Unix epoch milliseconds. */
export const sweepExpiredWorkersAiAdmission = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, WorkersAiAdmissionUnavailable> =>
  expireAdmission(input).pipe(Effect.mapError(() => new WorkersAiAdmissionUnavailable()));
