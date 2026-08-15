import { expect, it } from "@effect/vitest";
import { BigDecimal, Equal, Result, Schema, SchemaIssue } from "effect";
import { DeliveryEvidenceInput, InsightEvent, InsightGenerationInput } from "./model";

type InsightOccurrenceInput = typeof InsightEvent.Encoded;
type MoneyGroupInput = InsightOccurrenceInput["moneyGroups"][number];

const occurrence = (overrides: Partial<InsightOccurrenceInput> = {}): InsightOccurrenceInput => ({
  id: "f1d1a000-0000-4000-8000-000000000101",
  kind: "weekly-summary",
  scheduleId: "f1d1a000-0000-4000-8000-000000000201",
  scheduleVersion: 2,
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  scheduledAt: "2026-08-09T23:00:00Z",
  moneyGroups: [
    {
      currency: "COP",
      inflow: { amount: "2000000", currency: "COP" },
      outflow: { amount: "850000", currency: "COP" },
    },
    {
      currency: "USD",
      inflow: { amount: "0", currency: "USD" },
      outflow: { amount: "24.5", currency: "USD" },
    },
  ],
  lifecycleState: "pending",
  ...overrides,
});

it("decodes a generated occurrence with deterministic Currency groups", () => {
  const event = Schema.decodeUnknownSync(InsightEvent)(occurrence());

  expect(event.scheduleVersion).toBe(2);
  expect(event.moneyGroups).toHaveLength(2);
  expect(event.moneyGroups[0]?.currency).toBe("COP");
  expect(event.moneyGroups[1]?.currency).toBe("USD");
  expect(
    Equal.equals(event.moneyGroups[1]?.outflow.amount, BigDecimal.fromStringUnsafe("24.5"))
  ).toBe(true);
});

it("derives generation input without server-assigned identity or lifecycle", () => {
  const { id: _id, lifecycleState: _lifecycleState, ...input } = occurrence();

  expect(() => Schema.decodeUnknownSync(InsightGenerationInput)(input)).not.toThrow();
});

it("derives delivery input without server-assigned attempt or InsightEvent identity", () => {
  expect(() =>
    Schema.decodeUnknownSync(DeliveryEvidenceInput)({
      sentAt: "2026-08-09T23:00:08Z",
      channel: "whatsapp",
      provider: "kapso",
      providerMessageId: "wamid.delivery-101",
    })
  ).not.toThrow();
});

it("bounds persisted delivery evidence fields", () => {
  const decode = Schema.decodeUnknownResult(DeliveryEvidenceInput);
  const evidence = {
    sentAt: "2026-08-09T23:00:08Z",
    channel: "c".repeat(32),
    provider: "p".repeat(64),
    providerMessageId: "m".repeat(256),
  };

  expect(Result.isSuccess(decode(evidence))).toBe(true);
  for (const field of ["channel", "provider", "providerMessageId"] as const) {
    expect(Result.isFailure(decode({ ...evidence, [field]: `${evidence[field]}x` }))).toBe(true);
  }
});

it("rejects schedule revision zero", () => {
  expect(
    Result.isFailure(Schema.decodeUnknownResult(InsightEvent)(occurrence({ scheduleVersion: 0 })))
  ).toBe(true);
});

it("rejects Currency groups that are duplicated or out of alphabetic order", () => {
  const groups = occurrence().moneyGroups;
  const unordered = Schema.decodeUnknownResult(InsightEvent)(
    occurrence({ moneyGroups: [...groups].reverse() })
  );
  expect(Result.isFailure(unordered)).toBe(true);
  expect(
    Result.isFailure(unordered)
      ? SchemaIssue.makeFormatterStandardSchemaV1()(unordered.failure.issue).issues[0]?.path
      : undefined
  ).toEqual(["moneyGroups", 1, "currency"]);
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(InsightEvent)(occurrence({ moneyGroups: [...groups, ...groups] }))
    )
  ).toBe(true);
});

it("rejects inflow or outflow Money whose Currency disagrees with its group", () => {
  const mismatches = [
    {
      currency: "COP",
      inflow: { amount: "1", currency: "USD" },
      outflow: { amount: "2", currency: "COP" },
    },
    {
      currency: "COP",
      inflow: { amount: "1", currency: "COP" },
      outflow: { amount: "2", currency: "USD" },
    },
  ] satisfies ReadonlyArray<MoneyGroupInput>;

  for (const [index, mismatch] of mismatches.entries()) {
    const result = Schema.decodeUnknownResult(InsightEvent)(
      occurrence({ moneyGroups: [mismatch] })
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(
      Result.isFailure(result)
        ? SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues[0]?.path
        : undefined
    ).toEqual(["moneyGroups", 0, index === 0 ? "inflow" : "outflow", "currency"]);
  }
});

it("rejects all-zero Currency groups as meaningless persisted data", () => {
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(InsightEvent)(
        occurrence({
          moneyGroups: [
            {
              currency: "COP",
              inflow: { amount: "0", currency: "COP" },
              outflow: { amount: "0", currency: "COP" },
            },
          ],
        })
      )
    )
  ).toBe(true);
});
