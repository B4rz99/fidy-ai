import { SourceAttestation } from "~/core/source-attestation/contract";
import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { CapturedInterpretationContext } from "~/core/interpretation-evidence/contract";
import {
  CreateTransactionInput,
  Direction,
  RestoredTransactionPair,
  Transaction,
  TransactionExtraction,
  TransactionPresentation,
  TransactionQueryValues,
  UpdateTransactionInput,
} from "./contract";

const decodeDirection = Schema.decodeUnknownResult(Direction);
const decodeTransaction = Schema.decodeUnknownResult(Transaction);
const decodeCreateInput = Schema.decodeUnknownResult(CreateTransactionInput);
const decodeExtraction = Schema.decodeUnknownResult(TransactionExtraction);

type TransactionInput = typeof Transaction.Encoded;

/**
 * A whole Transaction as it arrives in an API request, defaulted so a test spells out
 * only the field it is about: an outflow of 25.000 COP to "El Corral".
 */
const apiTransaction = (overrides: Partial<TransactionInput> = {}): TransactionInput => ({
  id: "f1d1a000-0000-4000-8000-0000000000aa",
  money: { amount: "25000", currency: "COP" },
  counterparty: "El Corral",
  direction: "outflow",
  categoryId: "10000000-0000-4000-8000-000000000001",
  occurredAt: "2026-07-20T12:30:00Z",
  createdAt: "2026-07-21T08:00:00Z",
  revision: 0,
  ...overrides,
});

it("preserves agent-facing timestamp meanings through calendar refinement JSON Schema derivation", () => {
  const definitions = Schema.toJsonSchemaDocument(Transaction).definitions;
  expect(definitions.TransactionOccurredAt).toHaveProperty(
    "description",
    expect.stringContaining("When the money actually moved")
  );
  expect(definitions.TransactionCreatedAt).toHaveProperty(
    "description",
    expect.stringContaining("When fidy learned of it")
  );
});

it("accepts both of the two ways money can move", () => {
  expect(Result.isSuccess(decodeDirection("outflow"))).toBe(true);
  expect(Result.isSuccess(decodeDirection("inflow"))).toBe(true);
});

it("rejects a third kind of movement, which is a domain decision and not a spelling", () => {
  expect(Result.isFailure(decodeDirection("transfer"))).toBe(true);
});

it("accepts a positive Transaction with nested Money and both instants", () => {
  expect(Result.isSuccess(decodeTransaction(apiTransaction()))).toBe(true);
});

it("accepts a Transaction whose captured material identifies no Counterparty", () => {
  const { counterparty: _, ...withoutCounterparty } = apiTransaction();

  expect(Result.isSuccess(decodeTransaction(withoutCounterparty))).toBe(true);
});

it("bounds a Counterparty to the same length wherever it is read", () => {
  const longest = "a".repeat(120);
  const filter = Schema.decodeUnknownResult(TransactionQueryValues.fields.counterparty);

  expect(Result.isSuccess(decodeTransaction(apiTransaction({ counterparty: longest })))).toBe(true);
  expect(Result.isFailure(decodeTransaction(apiTransaction({ counterparty: `${longest}a` })))).toBe(
    true
  );
  expect(Result.isSuccess(filter(longest))).toBe(true);
  expect(Result.isFailure(filter(`${longest}a`))).toBe(true);
});

it("accepts Transaction Money in a Currency independent of the Colombia ServiceMarket", () => {
  expect(
    Result.isSuccess(
      decodeTransaction(apiTransaction({ money: { amount: "12.34", currency: "USD" } }))
    )
  ).toBe(true);
});

it("rejects zero Transaction Money at the nested amount field", () => {
  const decoded = decodeTransaction(apiTransaction({ money: { amount: "0", currency: "COP" } }));

  expect(Result.isFailure(decoded) ? String(decoded.failure) : "").toContain('["money"]["amount"]');
});

it("preserves positive Money checks in independent and linked Transaction presentations", () => {
  const decode = Schema.decodeUnknownResult(TransactionPresentation);
  for (const presentation of [
    { kind: "independent" },
    { kind: "visible-member" },
    { kind: "suppressed-member", requestedId: "f1d1a000-0000-4000-8000-0000000000bb" },
  ]) {
    expect(Result.isSuccess(decode({ ...apiTransaction(), presentation }))).toBe(true);
    expect(
      Result.isFailure(
        decode({ ...apiTransaction({ money: { amount: "0", currency: "COP" } }), presentation })
      )
    ).toBe(true);
  }
});

it("rejects restored pairs with zero Money in either independent Transaction", () => {
  const decode = Schema.decodeUnknownResult(RestoredTransactionPair);
  const positive = { ...apiTransaction(), presentation: { kind: "independent" } };
  const zero = {
    ...apiTransaction({ money: { amount: "0", currency: "COP" } }),
    presentation: { kind: "independent" },
  };
  expect(
    Result.isSuccess(decode({ firstTransaction: positive, secondTransaction: positive }))
  ).toBe(true);
  expect(Result.isFailure(decode({ firstTransaction: zero, secondTransaction: positive }))).toBe(
    true
  );
  expect(Result.isFailure(decode({ firstTransaction: positive, secondTransaction: zero }))).toBe(
    true
  );
});

it("rejects the legacy top-level amount and currency shape", () => {
  const { money: _, ...withoutMoney } = apiTransaction();

  expect(
    Result.isFailure(decodeTransaction({ ...withoutMoney, amount: 25_000, currency: "COP" }))
  ).toBe(true);
});

it("allows Category omission only on capture input", () => {
  const {
    categoryId: _,
    createdAt: _createdAt,
    id: _id,
    revision: _revision,
    ...capture
  } = apiTransaction();

  expect(Result.isSuccess(decodeCreateInput(capture))).toBe(true);
  expect(Result.isFailure(decodeTransaction(capture))).toBe(true);
});

it("derives extraction facts with nested exact Money", () => {
  expect(
    Result.isSuccess(
      decodeExtraction({
        money: { amount: "450000000000.75", currency: "USD" },
        counterparty: "Proveedor",
        direction: "outflow",
        occurredAt: "2026-07-20T12:30:00Z",
      })
    )
  ).toBe(true);
});

it("carries no owner, so a client cannot name whose transaction it is creating", () => {
  expect(Object.keys(CreateTransactionInput.fields)).not.toContain("userId");
});

it("accepts both manual and statement-line provenance variants", () => {
  const common = {
    id: "f1d1a000-0000-4000-8000-000000000101",
    transactionId: "f1d1a000-0000-4000-8000-000000000102",
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
    interpretationRevision: "manual-v1",
    createdAt: "2026-07-21T08:00:00Z",
  };
  const decode = Schema.decodeUnknownResult(SourceAttestation);

  expect(Result.isSuccess(decode({ ...common, kind: "manual" }))).toBe(true);
  expect(
    Result.isSuccess(
      decode({
        ...common,
        kind: "statement-line",
        statementSubmissionId: "f1d1a000-0000-4000-8000-000000000103",
        statementRecordNumber: 7,
        statementContentHash: "sha256:row",
        sourceFormat: "csv",
        extractorRevision: "extractor-v1",
      })
    )
  ).toBe(true);
});

it("derives input and evidence fields from their canonical models", () => {
  const captureFields = Object.keys(Transaction.fields).filter(
    (field) => field !== "id" && field !== "createdAt" && field !== "revision"
  );
  expect(Object.keys(CreateTransactionInput.fields)).toEqual(captureFields);
  expect(Object.keys(UpdateTransactionInput.fields)).toEqual(["expectedRevision", "changes"]);
  expect(Object.keys(TransactionExtraction.fields)).toEqual([
    "money",
    "counterparty",
    "direction",
    "occurredAt",
  ]);
  expect(Object.keys(CapturedInterpretationContext.fields)).toEqual([
    "serviceMarket",
    "locale",
    "timeZone",
  ]);
});
