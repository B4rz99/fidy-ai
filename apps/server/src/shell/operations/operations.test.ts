import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { operationCatalog } from "~/shell/api";
import { getAtomicBatchCallSchema } from "./contract";

it("keeps mailbox-proof replacement out of atomic batches", () => {
  expect(
    operationCatalog.byId.get("emailAuthentication.requestEmailReplacement")?.atomicBatchEligible
  ).toBe(false);
  expect(
    operationCatalog.byId.get("emailAuthentication.completeEmailReplacement")?.atomicBatchEligible
  ).toBe(false);
  const decode = Schema.decodeUnknownOption(getAtomicBatchCallSchema());
  const callId = "10000000-0000-4000-8000-000000000001";
  expect(
    decode({
      callId,
      operation: "emailAuthentication.requestEmailReplacement",
      input: {
        payload: { candidateEmail: "other@example.test" },
      },
    })._tag
  ).toBe("None");
  expect(
    decode({
      callId,
      operation: "emailAuthentication.completeEmailReplacement",
      input: {
        payload: { combinedCode: "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ" },
      },
    })._tag
  ).toBe("None");
});

it("keeps held-only statement publication out of the public atomic-batch child union", () => {
  // Statement publication remains an atomic owner mutation, but public HTTP batches cannot
  // supply its verified WhatsApp attachment and live original-Turn authority.
  const ingestion = operationCatalog.byId.get("ingestion.submitForExtraction");
  expect(ingestion?.atomicBatchEligible).toBe(true);
  expect(ingestion?.policy.kind).toBe("mutation");
  const callId = "10000000-0000-4000-8000-000000000002";
  const decode = Schema.decodeUnknownOption(getAtomicBatchCallSchema());
  expect(
    decode({
      callId,
      operation: "ingestion.submitForExtraction",
      input: {
        payload: {
          idempotencyKey: "20000000-0000-4000-8000-000000000201",
          reference: {
            stagingId: "30000000-0000-4000-8000-000000000301",
            byteLength: 42,
            sha256: "a".repeat(64),
          },
        },
      },
    })._tag
  ).toBe("None");
});
