import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Option, Result, Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { categoryIds } from "~/core/categories/taxonomy";
import { FidyApi, operationCatalog } from "~/shell/api";
import {
  canCallOperation,
  checkpointSuggestedOperations,
  suggestOperation,
} from "./suggested-operations";
import { SuggestedOperation } from "./response";

const allCapabilities = ["read", "write", "dashboard"] as const;
const freeCaller = { capabilities: allCapabilities, tier: "free" } as const;
const strictEncoding = { errors: "all", onExcessProperty: "error" } as const;

const SuggestedMemberSpec = Schema.Struct({
  properties: Schema.Struct({
    tool: Schema.Struct({ enum: Schema.Array(Schema.String) }),
    args: Schema.optionalKey(Schema.Unknown),
  }),
});

it("publishes one partial-input OpenAPI member per canonical operation", () => {
  const spec = OpenApi.fromApi(FidyApi);
  const suggested = Schema.decodeUnknownSync(
    Schema.Struct({ anyOf: Schema.Array(SuggestedMemberSpec) })
  )(spec.components.schemas.SuggestedOperation);
  const publishedTools = suggested.anyOf.flatMap((member) => member.properties.tool.enum);
  const publishedOperationIds = Object.values(spec.paths).flatMap((path) =>
    Object.values(path).map((operation) => operation.operationId)
  );
  const createMember = suggested.anyOf.find((member) =>
    member.properties.tool.enum.includes("transactions.createTransaction")
  );
  const createArgs = Schema.decodeUnknownSync(
    Schema.Struct({
      properties: Schema.Struct({
        payload: Schema.Struct({
          required: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      }),
    })
  )(createMember?.properties.args);

  expect(publishedTools.sort()).toEqual(publishedOperationIds.sort());
  expect(publishedTools).toEqual(
    operationCatalog.operations.map((operation) => operation.id).sort()
  );
  expect(createArgs.properties.payload.required).toBeUndefined();
});

it("accepts typed partials without running checks whose nested input is incomplete", () => {
  const counterpartyOnly = suggestOperation({
    tool: "transactions.createTransaction",
    args: Option.some({ payload: { counterparty: Option.some("Rappi") } }),
    hint: "Record the Transaction while its counterparty is known.",
  });
  const incompleteMoney = suggestOperation({
    tool: "transactions.createTransaction",
    args: Option.some({
      payload: {
        money: { currency: "COP" },
        counterparty: Option.some("Rappi"),
        direction: "outflow",
        occurredAt: DateTime.makeUnsafe("2026-07-20T12:30:00Z"),
      },
    }),
    hint: "Record the Transaction after learning its amount.",
  });

  expect(
    checkpointSuggestedOperations({
      candidates: [counterpartyOnly, incompleteMoney],
      caller: freeCaller,
    })
  ).toEqual([counterpartyOnly, incompleteMoney]);
});

it("rejects fully known arguments that violate a target object check", () => {
  const invalidTransaction = Schema.encodeUnknownResult(
    SuggestedOperation,
    strictEncoding
  )({
    tool: "transactions.createTransaction",
    args: Option.some({
      payload: {
        money: { amount: BigDecimal.fromStringUnsafe("0"), currency: "COP" },
        counterparty: "Rappi",
        direction: "outflow",
        occurredAt: DateTime.makeUnsafe("2026-07-20T12:30:00Z"),
        categoryId: categoryIds.otros,
      },
    }),
    hint: "Record the Transaction while all its details are known.",
  });

  expect(Result.isFailure(invalidTransaction)).toBe(true);
});

it("rejects tools and arguments that do not belong to a canonical operation", () => {
  const unknownTool = Schema.encodeUnknownResult(
    SuggestedOperation,
    strictEncoding
  )({
    tool: "transactions.eraseEverything",
    hint: "Erase everything now.",
  });
  const invalidArgument = Schema.encodeUnknownResult(
    SuggestedOperation,
    strictEncoding
  )({
    tool: "transactions.getTransaction",
    args: Option.some({ params: { id: "not-a-transaction-id" } }),
    hint: "Fetch the Transaction already under discussion.",
  });
  const inputForInputlessOperation = Schema.encodeUnknownResult(
    SuggestedOperation,
    strictEncoding
  )({
    tool: "identity.getCurrentUser",
    args: {},
    hint: "Read the current User preferences.",
  });

  expect(Result.isFailure(unknownTool)).toBe(true);
  expect(Result.isFailure(invalidArgument)).toBe(true);
  expect(Result.isFailure(inputForInputlessOperation)).toBe(true);
});

it("accepts one sentence containing an abbreviation or version number", () => {
  const abbreviated = Schema.encodeUnknownResult(SuggestedOperation)({
    tool: "transactions.listTransactions",
    args: Option.none(),
    hint: "List Transactions, e.g. the latest matching entries.",
  });
  const versioned = Schema.encodeUnknownResult(SuggestedOperation)({
    tool: "transactions.listTransactions",
    args: Option.none(),
    hint: "Use v1.2 to list the matching Transactions.",
  });

  expect(Result.isSuccess(abbreviated)).toBe(true);
  expect(Result.isSuccess(versioned)).toBe(true);
});

it("rejects a multi-sentence or overlong hint", () => {
  const multiSentence = Schema.encodeUnknownResult(SuggestedOperation)({
    tool: "transactions.listTransactions",
    args: Option.none(),
    hint: "List Transactions. Then inspect them.",
  });
  const overlong = Schema.encodeUnknownResult(SuggestedOperation)({
    tool: "transactions.listTransactions",
    args: Option.none(),
    hint: `${"x".repeat(140)}.`,
  });

  expect(Result.isFailure(multiSentence)).toBe(true);
  expect(Result.isFailure(overlong)).toBe(true);
});

it("filters missing scopes before enforcing the three-item cap", () => {
  const write = suggestOperation({
    tool: "transactions.createTransaction",
    args: Option.none(),
    hint: "Record the Transaction while its details are known.",
  });
  const read = suggestOperation({
    tool: "transactions.listTransactions",
    args: Option.none(),
    hint: "List Transactions to answer the current question.",
  });

  expect(
    checkpointSuggestedOperations({
      candidates: [write, write, write, read],
      caller: { capabilities: ["read"], tier: "free" },
    })
  ).toEqual([read]);
});

it("fails loudly when more than three callable operations remain", () => {
  const read = suggestOperation({
    tool: "transactions.listTransactions",
    args: Option.none(),
    hint: "List Transactions to answer the current question.",
  });

  expect(() =>
    checkpointSuggestedOperations({
      candidates: [read, read, read, read],
      caller: freeCaller,
    })
  ).toThrow();
});

it("keeps Pro operations out of free responses", () => {
  const policy = {
    requiredCapability: "read",
    capabilityEvaluation: "operation",
    callerEligibility: "authenticated",
    requiredTier: "pro",
    agentConfirmation: "not-required",
    kind: "query",
  } as const;

  expect(canCallOperation(policy, freeCaller)).toBe(false);
  expect(canCallOperation({ capabilities: ["read"], tier: "pro" })(policy)).toBe(true);
});
