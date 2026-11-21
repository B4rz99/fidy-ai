import type { SampleReviewResult } from "../../../src/core/ingestion/contract";

const headers = { "cache-control": "no-store" };

export const sampleReply = (status: number): Response => new Response(null, { status, headers });

export const sampleOutcome = (result: typeof SampleReviewResult.Type): Response =>
  Response.json(result, { headers });

export const sampleStatus = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  unavailable: 503,
} as const;
