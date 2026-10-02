import { expect, it } from "@effect/vitest";
import { parseCsv } from "./parser";

it("bounds the raw mapping sample without dropping parser rows", () => {
  const records = Array.from(
    { length: 6 },
    (_, index) => `2026-02-0${index + 1},${index + 1},Description ${index + 1}`
  );
  const parsed = parseCsv(
    new TextEncoder().encode(`Date,Amount,Description\n${records.join("\n")}`)
  );

  expect(parsed.rows).toHaveLength(6);
  expect(parsed.sampleRows).toHaveLength(5);
  expect(parsed.sampleRows[4]).toEqual(["2026-02-05", "5", "Description 5"]);
  expect(parsed.sampleRows.flat()).not.toContain("Description 6");
});
