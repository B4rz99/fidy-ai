import {
  type StatementParseFailed,
  parseStatementFile,
  statementParserLimits,
} from "@fidy/server/statement-parser";
import { Effect } from "effect";
import { BoundedBodyReadFailed, collectBoundedRequestBody } from "../http/bounded-request-body";

type RejectionReason =
  | BoundedBodyReadFailed["reason"]
  | StatementParseFailed["safeReason"]
  | "not-found";

const statusByReason = {
  cancelled: 499,
  "malformed-file": 422,
  "not-found": 404,
  "resource-limit": 413,
  "unsupported-format": 422,
} as const satisfies Record<RejectionReason, number>;

const failureResponse = (reason: RejectionReason): Response =>
  Response.json({ outcome: "rejected", reason }, { status: statusByReason[reason] });

const parseRequest = Effect.fn(function* (request: Request) {
  const startedAt = performance.now();
  const bytes = yield* collectBoundedRequestBody(
    request,
    statementParserLimits.maximumDecodedBytes
  );
  const parsed = yield* parseStatementFile(bytes);
  return Response.json({
    elapsedMilliseconds: performance.now() - startedAt,
    format: parsed.sourceFormat,
    outcome: "parsed",
    rowCount: parsed.rows.length,
  });
});

const fetch = (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/statement") {
    return Promise.resolve(failureResponse("not-found"));
  }

  return parseRequest(request).pipe(
    Effect.match({
      onFailure: (failure) => {
        if (failure instanceof BoundedBodyReadFailed) {
          return failureResponse(failure.reason);
        }
        const reason = failure.safeReason;
        return failureResponse(reason);
      },
      onSuccess: (response) => response,
    }),
    Effect.runPromise
  );
};

/**
 * Accepts `POST /statement` with at most the parser's compressed-input ceiling. It returns only
 * source format, row count, elapsed handler time, and a closed rejection reason. Body-stream
 * cancellation interrupts collection; parsing is bounded synchronous work. No binding or outbound
 * capability is available to the entrypoint.
 */
export const documentParsingWorker = { fetch };

export default documentParsingWorker;
