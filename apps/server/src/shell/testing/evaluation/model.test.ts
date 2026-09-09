import { expect, it } from "@effect/vitest";
import { CaseResult, RunReport } from "./model";

const forbiddenReportFields = [
  "prompt",
  "reply",
  "transaction",
  "record",
  "image",
  "toolArguments",
  "providerBody",
  "cause",
  "secret",
];

it("has no report slots capable of retaining sensitive evaluation bodies", () => {
  const reportFields = new Set(Object.keys(RunReport.fields));
  const caseFields = new Set(Object.keys(CaseResult.fields));
  for (const field of forbiddenReportFields) {
    expect(reportFields.has(field)).toBe(false);
    expect(caseFields.has(field)).toBe(false);
  }
});
