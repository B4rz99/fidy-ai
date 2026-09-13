import { expect, it } from "@effect/vitest";
import { Duration } from "effect";
import {
  maximumHostedTurnIterations,
  maximumModelRoundMillis,
} from "~/shell/_shared/hosted-turn-bounds";
import {
  productionRunnerConnectDeadline,
  productionRunnerHealthDeadline,
  productionRunnerRequestDeadline,
} from "./durable-execution";

it("keeps connection and health bounds below the hosted Work exchange budget", () => {
  const hostedTurnBudgetMillis = maximumHostedTurnIterations * maximumModelRoundMillis;
  expect(Duration.toMillis(productionRunnerConnectDeadline)).toBe(5_000);
  expect(Duration.toMillis(productionRunnerHealthDeadline)).toBe(10_000);
  expect(Duration.toMillis(productionRunnerRequestDeadline)).toBe(
    hostedTurnBudgetMillis + 10 * 60_000
  );
  expect(Duration.toMillis(productionRunnerConnectDeadline)).toBeLessThan(
    Duration.toMillis(productionRunnerHealthDeadline)
  );
  expect(Duration.toMillis(productionRunnerHealthDeadline)).toBeLessThan(
    Duration.toMillis(productionRunnerRequestDeadline)
  );
});
