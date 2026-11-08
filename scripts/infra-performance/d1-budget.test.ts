import { describe, expect, it } from "vitest";
import { Clock, DateTime, Effect, Schema } from "effect";
import { assessFreeD1BenchmarkBudget } from "./d1-budget";

const accountId = "a".repeat(32);
const nowEpochMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-29T20:20:00Z"));
const observation = {
  accountId,
  utcDate: "2026-10-29",
  observedAtEpochMs: nowEpochMs,
  rowsRead: 100_000,
  rowsWritten: 10_000,
};
const estimate = { rowsRead: 100_000, rowsWritten: 5_000 };
const input = { accountId, nowEpochMs, observation, estimate };

describe("account-wide Free D1 benchmark headroom", () => {
  it("admits a bounded experiment within the actual allowance", () => {
    expect(assessFreeD1BenchmarkBudget(input)).toEqual({
      _tag: "Allowed",
      maximumRowsRead: 100_000,
      maximumRowsWritten: 5_000,
    });
  });
  it.each([
    undefined,
    {},
    { ...input, observation: null },
    { ...input, observation: { ...observation, accountId: "b".repeat(32) } },
  ])("refuses unavailable or foreign usage evidence", (raw) => {
    expect(assessFreeD1BenchmarkBudget(raw)).toEqual({
      _tag: "Refused",
      reason: "invalid_observation",
    });
  });
  it.each([-1, 60_001])("refuses future or stale usage observations", (age) => {
    expect(
      assessFreeD1BenchmarkBudget({
        ...input,
        observation: { ...observation, observedAtEpochMs: nowEpochMs - age },
      })
    ).toEqual({ _tag: "Refused", reason: "stale_observation" });
  });
  it("does not reuse yesterday's allowance after midnight UTC", () => {
    expect(
      assessFreeD1BenchmarkBudget({
        ...input,
        observation: { ...observation, utcDate: "2026-10-28" },
      })
    ).toEqual({ _tag: "Refused", reason: "wrong_utc_day" });
  });
  it("admits a larger experiment without an artificial per-run cap", () => {
    expect(
      assessFreeD1BenchmarkBudget({
        ...input,
        estimate: { rowsRead: 200_000, rowsWritten: 20_000 },
      })
    ).toEqual({ _tag: "Allowed", maximumRowsRead: 200_000, maximumRowsWritten: 20_000 });
  });
  it.each([
    { rowsRead: 2_400_001, rowsWritten: 0 },
    { rowsRead: 0, rowsWritten: 60_647 },
  ])("admits work beyond the former reserve boundary", (counts) => {
    expect(
      assessFreeD1BenchmarkBudget({ ...input, observation: { ...observation, ...counts } })
    ).toEqual({ _tag: "Allowed", maximumRowsRead: 100_000, maximumRowsWritten: 5_000 });
  });
  it.each([
    { rowsRead: 4_900_001, rowsWritten: 0 },
    { rowsRead: 0, rowsWritten: 95_001 },
    { rowsRead: 890_181, rowsWritten: 107_974 },
  ])("refuses work beyond the actual Free-tier allowance", (counts) => {
    expect(
      assessFreeD1BenchmarkBudget({ ...input, observation: { ...observation, ...counts } })
    ).toEqual({ _tag: "Refused", reason: "allowance_exhausted" });
  });
  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid native usage counts",
    (rowsWritten) => {
      expect(
        assessFreeD1BenchmarkBudget({ ...input, observation: { ...observation, rowsWritten } })
      ).toEqual({ _tag: "Refused", reason: "invalid_observation" });
    }
  );
  it.each([NaN, Infinity, -1, 8_640_000_000_000_001])(
    "refuses a clock outside the supported date range",
    (nowEpochMs) => {
      expect(assessFreeD1BenchmarkBudget({ ...input, nowEpochMs })).toEqual({
        _tag: "Refused",
        reason: "invalid_observation",
      });
    }
  );
  it("uses its own clock when a CLI caller supplies stale evidence and a forged current time", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const yesterday = (yield* Clock.currentTimeMillis) - 86_400_000;
        const wire = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
          ...input,
          nowEpochMs: yesterday,
          observation: {
            ...observation,
            observedAtEpochMs: yesterday,
            utcDate: DateTime.formatIso(DateTime.makeUnsafe(yesterday)).slice(0, 10),
          },
        });
        const cli = Bun.spawnSync(["bun", "scripts/infra-performance/d1-budget.ts"], {
          stdin: new TextEncoder().encode(wire),
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(cli.exitCode).toBe(1);
        const output = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
          new TextDecoder().decode(cli.stdout)
        );
        expect(output).toEqual({ _tag: "Refused", reason: "stale_observation" });
      })
    ));
});
