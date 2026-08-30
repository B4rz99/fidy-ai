import { jsonStringSchema } from "~/schema-compatibility";
import { expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import {
  SentryAccountCheck,
  type SentryAccountObservation,
  type SentryProjectObservation,
  SentryVerificationReport,
  renderSentryVerificationReport,
  verifySentryAccount,
} from "./account-policy";

const makeProjectObservation = (
  overrides: Partial<SentryProjectObservation> = {}
): SentryProjectObservation => ({
  activeClientKeyRateLimits: [Option.none()],
  environments: ["production"],
  ...overrides,
});

const makeObservation = (
  overrides: Partial<SentryAccountObservation> = {}
): SentryAccountObservation => ({
  _tag: "available",
  storageRegion: Option.some("us"),
  projectsAreDistinct: true,
  production: Option.some(makeProjectObservation()),
  nonProduction: Option.some(
    makeProjectObservation({
      activeClientKeyRateLimits: [Option.some({ windowSeconds: 86_400, errorCount: 100 })],
      environments: ["local"],
    })
  ),
  ...overrides,
});

it("verifies the live account when API observations match policy", () => {
  const report = verifySentryAccount({ observation: makeObservation() });

  expect(report.overall).toBe("verified");
  expect(report.findings.every((finding) => finding.status === "verified")).toBe(true);
  expect(report.findings.find((finding) => finding.check === "project-separation")).toEqual({
    check: "project-separation",
    status: "verified",
    source: "live-api",
  });
  expect(
    report.findings.find((finding) => finding.check === "non-production-error-ceiling")
  ).toEqual({
    check: "non-production-error-ceiling",
    status: "verified",
    source: "live-api",
  });
});

it("fails closed when the account API is unavailable", () => {
  const report = verifySentryAccount({ observation: { _tag: "unavailable" } });

  expect(report.overall).toBe("mismatch");
  expect(
    report.findings
      .filter((finding) => finding.check !== "quota-response-actions")
      .every((finding) => finding.status === "mismatch" && finding.source === "unavailable")
  ).toBe(true);
});

it("rejects any active key whose quota conflicts with its project policy", () => {
  const observation = makeObservation({
    production: Option.some(
      makeProjectObservation({
        activeClientKeyRateLimits: [
          Option.none(),
          Option.some({ windowSeconds: 60, errorCount: 1 }),
        ],
      })
    ),
    nonProduction: Option.some(
      makeProjectObservation({
        activeClientKeyRateLimits: [
          Option.some({ windowSeconds: 86_400, errorCount: 100 }),
          Option.none(),
        ],
        environments: ["local"],
      })
    ),
  });
  const report = verifySentryAccount({ observation });

  expect(report.overall).toBe("mismatch");
  expect(
    report.findings.find((finding) => finding.check === "production-key-unlimited")?.status
  ).toBe("mismatch");
  expect(
    report.findings.find((finding) => finding.check === "non-production-error-ceiling")?.status
  ).toBe("mismatch");
});

it("rejects one project supplied for both policy roles", () => {
  const report = verifySentryAccount({
    observation: makeObservation({ projectsAreDistinct: false }),
  });

  expect(report.findings.find((finding) => finding.check === "project-separation")?.status).toBe(
    "mismatch"
  );
});

it("rejects incomplete or internally inconsistent report values", () => {
  const decode = Schema.decodeUnknownExit(SentryVerificationReport);

  expect(
    decode({
      policyRevision: 2,
      overall: "verified",
      findings: [{ check: "storage-region", status: "mismatch", source: "unavailable" }],
      quotaResponseActions: [],
    })._tag
  ).toBe("Failure");
});

it("renders only the complete closed secret-free verification shape", () => {
  const report = verifySentryAccount({ observation: makeObservation() });
  const rendered = Schema.decodeSync(
    jsonStringSchema(Schema.Record(Schema.String, Schema.Unknown))
  )(renderSentryVerificationReport(report));

  expect(Object.keys(rendered).sort()).toEqual([
    "findings",
    "overall",
    "policyRevision",
    "quotaResponseActions",
  ]);
  expect(Array.isArray(rendered.findings) ? rendered.findings : []).toHaveLength(
    SentryAccountCheck.literals.length
  );
  expect(rendered.quotaResponseActions).toEqual([
    { quota: "spans", usagePercentage: 50, action: "alert-and-review" },
    {
      quota: "spans",
      usagePercentage: 75,
      action: "reduce-production-roots-to-5%-and-disable-local",
    },
    { quota: "spans", usagePercentage: 90, action: "reduce-production-roots-to-1%" },
    {
      quota: "errors",
      usagePercentage: 75,
      action: "disable-local-errors-investigate-keep-production-unsampled",
    },
  ]);
});
