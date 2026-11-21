import { measureStatementWork } from "./statement-work-proof";
import {
  type StatementParseFailed,
  statementParserLimits,
} from "../../src/shell/ingestion/contract";
import { parseStatementFile } from "../../src/shell/ingestion/operations";
import { Effect, Option, Predicate, Schema } from "effect";
import type { BoundedBodyReadFailed } from "../http/contract";
import { collectBoundedRequestBody } from "../http/operations";

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

  const work =
    new URL(request.url).pathname === "/statement-work" ? yield* measureStatementWork(parsed) : {};

  return Response.json({
    ...work,
    elapsedMilliseconds: performance.now() - startedAt,
    format: parsed.sourceFormat,
    outcome: "parsed",
    rowCount: parsed.rows.length,
  });
});

const ProofKeyBinding = Schema.Struct({ XLSX_PROOF_KEY: Schema.String });

const fetch = (request: Request, env: unknown = {}): Promise<Response> => {
  const binding = Schema.decodeUnknownOption(ProofKeyBinding)(env);

  if (
    Option.isSome(binding) &&
    request.headers.get("X-Xlsx-Proof-Key") !== binding.value.XLSX_PROOF_KEY
  ) {
    return Promise.resolve(failureResponse("not-found"));
  }

  const url = new URL(request.url);

  if (request.method !== "POST" || !["/statement", "/statement-work"].includes(url.pathname)) {
    return Promise.resolve(failureResponse("not-found"));
  }

  return parseRequest(request).pipe(
    Effect.match({
      onFailure: (failure) => {
        if (Predicate.isTagged(failure, "BoundedBodyReadFailed")) {
          return failureResponse(failure.reason);
        }

        const reason = Predicate.isTagged(failure, "StatementParseFailed")
          ? failure.safeReason
          : "malformed-file";

        return failureResponse(reason);
      },
      onSuccess: (response) => response,
    }),
    Effect.runPromise
  );
};

export const documentParsingWorker = { fetch };

export default documentParsingWorker;
