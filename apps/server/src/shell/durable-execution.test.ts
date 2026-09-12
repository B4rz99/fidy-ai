import { expect, it } from "@effect/vitest";
import { Duration } from "effect";
import {
  maximumHostedTurnIterations,
  maximumModelRoundMillis,
} from "~/shell/_shared/hosted-turn-bounds";
import {
  productionRunnerHealthDeadline,
  productionRunnerRequestDeadline,
} from "./durable-execution";

it("sizes the Work exchange above the hosted Turn budget and the health probe below it", () => {
  const hostedTurnBudgetMillis = maximumHostedTurnIterations * maximumModelRoundMillis;
  expect(Duration.toMillis(productionRunnerHealthDeadline)).toBe(10_000);
  expect(Duration.toMillis(productionRunnerRequestDeadline)).toBe(
    hostedTurnBudgetMillis + 10 * 60_000
  );
  expect(Duration.toMillis(productionRunnerHealthDeadline)).toBeLessThan(
    Duration.toMillis(productionRunnerRequestDeadline)
  );
});
