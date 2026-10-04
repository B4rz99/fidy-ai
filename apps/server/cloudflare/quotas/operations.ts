import * as standing from "./internal/standing";
import { queryQuota } from "./internal/query";
import type { TransactionCaller } from "../canonical-work/contract";
import type { Effect } from "effect";

/** Required publication guards the same User and fails atomically when no Free unit remains. */
export const prepareConsumption: typeof standing.prepareConsumption = (input) =>
  standing.prepareConsumption(input);
/** Email may instead publish bounded deferral in the same unit when capacity is unavailable. */
export const prepareAvailableConsumption: typeof standing.prepareAvailableConsumption = (input) =>
  standing.prepareAvailableConsumption(input);
/** Exact owner-scoped acceptance fact for composing a guarded publication. */
export const allowanceConsumptionProof: typeof standing.allowanceConsumptionProof = (input) =>
  standing.allowanceConsumptionProof(input);
/** Current-period consumption for one explicit User; never inferred from Audit. */
export const allowanceConsumptionCount: typeof standing.allowanceConsumptionCount = (input) =>
  standing.allowanceConsumptionCount(input);
/** Closed constraint provenance, with unknown failures remaining unavailable. */
export const quotaFailure: typeof standing.quotaFailure = (input) => standing.quotaFailure(input);
/** Prepare a meter projection; the caller must guard disclosure in its D1 unit. */
export const quotaStatusStatement: typeof standing.quotaStatusStatement = (input) =>
  standing.quotaStatusStatement(input);
/** Snapshot the meter only under the exact same-User authority. */
export const prepareAuthorizedQuotaRead: typeof standing.prepareAuthorizedQuotaRead = (input) =>
  standing.prepareAuthorizedQuotaRead(input);
/** Malformed retained projections do not become zero consumption. */
export const decodeQuotaStatus: typeof standing.decodeQuotaStatus = (input) =>
  standing.decodeQuotaStatus(input);
/** Observe one explicit User for guarded composition, not as reusable permission. */
export const readQuotaStatus: typeof standing.readQuotaStatus = (input) =>
  standing.readQuotaStatus(input);
/** Canonical HTTP and hosted inspection share one guarded query and Audit unit, without commercial charge. */
export const executeProtectedQuotaQuery = (
  input: Readonly<{ db: D1Database; subject: TransactionCaller }>
): Effect.Effect<Response> => queryQuota(input);
