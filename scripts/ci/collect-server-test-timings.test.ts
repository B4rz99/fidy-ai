import { describe, expect, it } from "vitest";
import { collectServerTestTimings } from "./collect-server-test-timings";

const report = (suites: string): string =>
  `<?xml version="1.0" encoding="UTF-8" ?><testsuites>${suites}</testsuites>`;

const suite = (name: string, seconds: string): string =>
  `<testsuite failures="0" name="${name}" tests="1" time="${seconds}"></testsuite>`;

describe("server test timing collection", () => {
  it("collects sorted server file durations from every shard report", () => {
    expect(
      collectServerTestTimings([
        report(suite("src/shell/z.test.ts", "2.5")),
        report(
          `${suite("src/core/ignored.test.ts", "9")}${suite("src/shell/a.integration.test.ts", "1.25")}`
        ),
      ])
    ).toEqual({
      "src/shell/a.integration.test.ts": 1.25,
      "src/shell/z.test.ts": 2.5,
    });
  });

  it("keeps the slowest observation when reports repeat a file", () => {
    expect(
      collectServerTestTimings([
        report(suite("src/shell/repeated.test.ts", "3")),
        report(suite("src/shell/repeated.test.ts", "4.5")),
      ])
    ).toEqual({ "src/shell/repeated.test.ts": 4.5 });
  });

  it("rejects a malformed duration instead of poisoning shard assignment", () => {
    expect(() =>
      collectServerTestTimings([report(suite("src/shell/broken.test.ts", "not-a-number"))])
    ).toThrow("Invalid JUnit duration for src/shell/broken.test.ts");
  });
});
