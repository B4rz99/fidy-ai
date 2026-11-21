import { DateTime } from "effect";
import { allowancePeriod } from "../../../src/core/quotas/operations";
import type { QuotaStatus } from "../../../src/core/quotas/contract";
import { canonicalRequestProtection } from "../contract";
import { canonicalAllowanceHeaders } from "../../../src/shell/quotas/contract";

export const canonicalAdmissionUnavailable = (): Response =>
  Response.json(
    {
      error: { code: "unavailable", message: "The operation is unavailable. Retry later." },
      next: [],
    },
    { status: 503 }
  );

export const noAuthority = (): Response =>
  Response.json(
    {
      error: {
        code: "unauthenticated",
        message: "Present a currently authorized credential and retry.",
      },
      next: [],
    },
    { status: 401 }
  );

export const scopeMissing = (): Response =>
  Response.json(
    {
      error: {
        code: "scope_missing",
        message: "This credential lacks the required operation scope.",
      },
      next: [],
    },
    { status: 403 }
  );

export const invalid = (message: string): Response =>
  Response.json(
    { error: { code: "validation_failed", message, fields: [] }, next: [] },
    { status: 400 }
  );

export const rateLimited = (): Response =>
  Response.json(
    {
      error: {
        code: "rate_limited",
        message: "Too many concurrent or recent requests. Retry later.",
        retryAfterSeconds: canonicalRequestProtection.retryAfterSeconds,
      },
      next: [],
    },
    {
      status: 429,
      headers: { "retry-after": String(canonicalRequestProtection.retryAfterSeconds) },
    }
  );

export const exhausted = (current: number): Response =>
  Response.json(
    {
      error: {
        code: "quota_exhausted",
        message: "Your Free canonical-call allowance is exhausted.",
        allowance: "canonical_call",
        resetsAt: DateTime.formatIso(allowancePeriod(DateTime.makeUnsafe(current)).resetsAt),
      },
      next: [],
    },
    { status: 429 }
  );

export const attachStanding = ({
  response,
  status,
  current,
}: Readonly<{ response: Response; status: QuotaStatus; current: number }>): Response => {
  const headers = new Headers(response.headers);
  const meter = status.canonicalCalls;
  headers.set(canonicalAllowanceHeaders.allowance, "canonical_call");
  headers.set(
    canonicalAllowanceHeaders.limit,
    meter._tag === "Uncapped" ? "uncapped" : String(meter.limit)
  );
  headers.set(
    canonicalAllowanceHeaders.remaining,
    meter._tag === "Uncapped" ? "uncapped" : String(meter.remaining)
  );
  headers.set(
    canonicalAllowanceHeaders.resetsAt,
    DateTime.formatIso(allowancePeriod(DateTime.makeUnsafe(current)).resetsAt)
  );

  return new Response(response.body, { status: response.status, headers });
};
