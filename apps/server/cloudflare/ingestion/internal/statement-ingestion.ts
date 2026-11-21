import { maximumSubmissionInputBytes } from "../contract";
import { SubmitForExtractionInput } from "../../../src/shell/ingestion/contract";
import { type Effect, type Option, Schema } from "effect";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";

const HTTP_BAD_REQUEST = 400;

const noStore = { "cache-control": "no-store" } as const;

const submissionInputPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumSubmissionInputBytes,
  deadlineMilliseconds: 2_000,
});

const json = (body: unknown, status: number): Response =>
  Response.json(body, { headers: noStore, status });

export const validationFailed = (message: string): Response =>
  json({ error: { code: "validation_failed", fields: [], message }, next: [] }, HTTP_BAD_REQUEST);

export const submitForExtractionInput = (
  request: Request
): Effect.Effect<Option.Option<SubmitForExtractionInput>> =>
  boundedJsonBody({ request, policy: submissionInputPolicy, schema: SubmitForExtractionInput });
