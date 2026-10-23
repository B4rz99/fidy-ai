import { expect, it } from "@effect/vitest";
import { BigDecimal, Equal, Result, Schema, SchemaIssue } from "effect";
import {
  DeliveryEvidenceInput,
  InsightDeliveryDecision,
  InsightEvent,
  InsightGenerationInput,
  ProactivityMessageRole,
  ReminderCadence,
  ReminderStanding,
} from "./contract";

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
  const event = Schema.decodeSync(InsightEvent)(occurrence());

  expect(event.scheduleVersion).toBe(2);
  expect(event.moneyGroups).toHaveLength(2);
  expect(event.moneyGroups[0]?.currency).toBe("COP");
  expect(event.moneyGroups[1]?.currency).toBe("USD");
  expect(
    Equal.equals(event.moneyGroups[1]?.outflow.amount, BigDecimal.fromStringUnsafe("24.5"))
  ).toBe(true);
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
    Result.isFailure(Schema.decodeResult(InsightEvent)(occurrence({ scheduleVersion: 0 })))
  ).toBe(true);
});

it("rejects Currency groups that are duplicated or out of alphabetic order", () => {
  const groups = occurrence().moneyGroups;
  const unordered = Schema.decodeResult(InsightEvent)(
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
      Schema.decodeResult(InsightEvent)(occurrence({ moneyGroups: [...groups, ...groups] }))
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
    const result = Schema.decodeResult(InsightEvent)(occurrence({ moneyGroups: [mismatch] }));
    expect(Result.isFailure(result)).toBe(true);
    expect(
      Result.isFailure(result)
        ? SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues[0]?.path
        : undefined
    ).toEqual(["moneyGroups", 0, index === 0 ? "inflow" : "outflow", "currency"]);
  }
});

it("accepts generation facts before the operation assigns identity and lifecycle", () => {
  const { id: _, lifecycleState: __, ...input } = occurrence();
  const decoded = Schema.decodeSync(InsightGenerationInput)(input);
  expect(Schema.encodeSync(InsightGenerationInput)(decoded)).toEqual({
    ...input,
    scheduledAt: "2026-08-09T23:00:00.000Z",
  });
});

it("roundtrips persisted reminder standing without mixing attention states", () => {
  for (const value of [
    { _tag: "Attentive", unanswered: 0 },
    { _tag: "Attentive", unanswered: 2 },
    { _tag: "QuestionPending", unanswered: 3 },
    { _tag: "QuestionDelivered", unanswered: 3 },
    { _tag: "QuestionDelivered", unanswered: 4 },
    { _tag: "Paused", unanswered: 5, pausedAt: "2026-08-09T23:00:00.000Z" },
  ]) {
    expect(
      Schema.encodeSync(ReminderStanding)(Schema.decodeUnknownSync(ReminderStanding)(value))
    ).toEqual(value);
  }
  expect(
    Schema.decodeUnknownOption(ReminderStanding)({ _tag: "Attentive", unanswered: 3 })._tag
  ).toBe("None");
  expect(
    Schema.decodeUnknownOption(ReminderStanding)({ _tag: "QuestionDelivered", unanswered: 5 })._tag
  ).toBe("None");
});

it("roundtrips reminder instructions and temporal delivery decisions", () => {
  for (const value of [
    { kind: "daily" },
    { kind: "weekdays" },
    { kind: "every-three-days", anchorDate: "2026-08-09" },
    { kind: "weekly", weekday: 6 },
  ]) {
    expect(
      Schema.encodeSync(ReminderCadence)(Schema.decodeUnknownSync(ReminderCadence)(value))
    ).toEqual(value);
  }
  for (const value of [
    { _tag: "Ready" },
    { _tag: "Expired" },
    { _tag: "Deferred", nextEligibleAt: "2026-08-10T14:00:00.000Z" },
  ]) {
    expect(
      Schema.encodeSync(InsightDeliveryDecision)(
        Schema.decodeUnknownSync(InsightDeliveryDecision)(value)
      )
    ).toEqual(value);
  }
});

it("rejects all-zero Currency groups as meaningless persisted data", () => {
  expect(
    Result.isFailure(
      Schema.decodeResult(InsightEvent)(
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

it("accepts financial occurrences and contextual offers as distinct proactive roles", () => {
  for (const role of [
    "budget-threshold",
    "manual-entry-reminder",
    "budget-offer",
    "reminder-offer",
    "recurring-offer",
    "reminder-question",
    "new-recurring-series",
  ]) {
    expect(Schema.decodeUnknownSync(ProactivityMessageRole)(role)).toBe(role);
  }
});

it("exports an anchored reminder date pattern for structured-output validators", () => {
  expect(Schema.toJsonSchemaDocument(ReminderCadence).definitions.ReminderAnchorDate).toMatchObject(
    { pattern: "^\\d{4}-\\d{2}-\\d{2}$" }
  );
});
