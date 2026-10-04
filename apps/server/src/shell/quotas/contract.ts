import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { QuotaStatus } from "~/core/quotas/contract";
import { operationPolicy, patScoped } from "~/shell/canonical-policy/contract";
import { OperationResponse, Unavailable } from "~/shell/public-http/contract";

/** Canonical response protocol names; never interpret security-rate headers as a commercial meter. */
export const canonicalAllowanceHeaders = {
  allowance: "fidy-canonical-allowance",
  limit: "fidy-canonical-limit",
  remaining: "fidy-canonical-remaining",
  resetsAt: "fidy-canonical-reset",
} as const;

const headerCount = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/u)).pipe(
  Schema.decodeTo(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
    )
  )
);
/** Allowlisted wire projection. Reset is an absolute UTC instant, never a Retry-After delay.
 * Uncapped means no visible commercial meter, not exemption from request/security protection.
 */
export const CanonicalAllowance = Schema.Union([
  Schema.Struct({
    allowance: Schema.Literal("canonical_call"),
    limit: headerCount,
    remaining: headerCount,
    resetsAt: Schema.DateTimeUtc,
  }).check(Schema.makeFilter((value) => value.remaining <= value.limit)),
  Schema.Struct({
    allowance: Schema.Literal("canonical_call"),
    limit: Schema.Literal("uncapped"),
    remaining: Schema.Literal("uncapped"),
    resetsAt: Schema.DateTimeUtc,
  }),
]);
export type CanonicalAllowance = typeof CanonicalAllowance.Type;

/** Observe independent Free meters; inspection remains callable when the canonical-call meter is exhausted. */
export const QuotasGroup = HttpApiGroup.make("quota").add(
  HttpApiEndpoint.get("getQuota", "/quota", {
    success: OperationResponse(QuotaStatus),
    error: Unavailable,
  })
    .annotate(
      OpenApi.Description,
      "Read your four independent Free allowances and exact America/Bogota month reset. This query consumes no canonical unit and remains available at zero remaining; Trial and Pro are uncapped."
    )
    .annotateMerge(
      operationPolicy({
        access: patScoped("read"),
        requiredTier: "free",
        agentConfirmation: "not-required",
        kind: "query",
      })
    )
);
