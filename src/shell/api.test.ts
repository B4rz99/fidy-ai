import { expect, it } from "@effect/vitest";
import { OpenApi } from "effect/unstable/httpapi";
import { FidyApi } from "./api";

const schemas = OpenApi.fromApi(FidyApi).components.schemas;

it("names every branded identifier as its own component", () => {
  for (const name of [
    "UserId",
    "CategoryId",
    "CategoryKeyword",
    "IanaTimeZone",
    "InsightEventId",
    "TransactionId",
    "WidgetId",
  ]) {
    expect(schemas).toHaveProperty(name);
  }
});

it("publishes UTC instants as date-time strings under one definition each", () => {
  const timestamps = Object.keys(schemas).filter((name) => name.startsWith("UtcTimestamp"));

  expect(timestamps).toEqual(["UtcTimestamp"]);
  expect(schemas["UtcTimestamp"]).toMatchObject({ type: "string", format: "date-time" });
  expect(schemas["TransactionOccurredAt"]).toMatchObject({ type: "string", format: "date-time" });
});
