import { Effect, Option, Schema } from "effect";
import { canonicalRequestProtection as policy } from "../../../apps/server/cloudflare/canonical-admission/contract";

const reviewPaths = new Set(["/ingestion/review-workspace", "/ingestion/review-workspace/context"]);

const snapshot = Schema.decodeUnknownOption(
  Schema.Struct({ pressure: Schema.Literals(["bucket", "leases", "both", "neither"]) })
);

const refused = 429;

export const withReviewPressureSnapshot = Effect.fn(function* ({
  owner,
  user,
  request,
  response,
}: {
  owner: { exec: (sql: string, ...bindings: (string | number)[]) => Promise<unknown[]> };
  user: string;
  request: Request;
  response: Response;
}) {
  if (
    response.status !== refused ||
    request.method !== "GET" ||
    !reviewPaths.has(new URL(request.url).pathname)
  ) {
    return response;
  }

  const rows = yield* Effect.tryPromise(() =>
    owner.exec(
      `WITH observed AS (
      SELECT EXISTS(SELECT 1 FROM canonical_request_buckets WHERE subject=?1
               AND virtual_at_ms>unixepoch('subsec')*1000+?2) AS bucket,
             (SELECT count(*) FROM canonical_request_leases WHERE user_id=?3
               AND expires_at_ms>unixepoch('subsec')*1000)>=?4 AS leases
    ) SELECT CASE WHEN bucket AND leases THEN 'both' WHEN bucket THEN 'bucket'
                  WHEN leases THEN 'leases' ELSE 'neither' END AS pressure FROM observed`,
      "user:" + user,
      (policy.burst - 1) * policy.intervalMs,
      user,
      policy.concurrency
    )
  ).pipe(Effect.timeout("500 millis"), Effect.option);

  const sample = Option.flatMap(rows, (values) => snapshot(values[0]));

  if (Option.isSome(sample)) {
    response.headers.set("x-reference-review-pressure", sample.value.pressure);
  }

  return response;
});
