import { expect, it } from "@effect/vitest";
import { DateTime, Option, Redacted, Schema } from "effect";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import { UserId } from "~/core/identity/reference";
import {
  BackupRecoveryCode,
  BackupRecoveryCredential,
  BackupRecoveryDigest,
  SupportOperatorId,
  SupportRecoveryCase,
  SupportRecoveryCaseEvent,
  SupportRecoveryCaseEventId,
  SupportRecoveryCaseId,
} from "./model";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000902");
const caseId = SupportRecoveryCaseId.make("f1d1a000-0000-4000-8000-000000000903");
const createdAt = DateTime.makeUnsafe("2026-08-23T12:00:00Z");

it("models active and consumed BackupRecoveryCredential authority as exclusive states", () => {
  const raw = Redacted.make(BackupRecoveryCode.make("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2"));
  const active = BackupRecoveryCredential.make({
    _tag: "Active",
    userId,
    codeDigest: BackupRecoveryDigest.make(new Uint8Array(32)),
    revision: 1,
    createdAt,
  });
  const consumed = BackupRecoveryCredential.make({
    _tag: "Consumed",
    userId,
    consumedAt: createdAt,
    consumedByCaseId: Option.some(caseId),
    revision: 1,
    createdAt,
  });

  expect(Redacted.value(raw)).toBe("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2");
  expect(active._tag).toBe("Active");
  if (active._tag === "Active") expect(active.codeDigest).toHaveLength(32);
  expect(consumed).not.toHaveProperty("codeDigest");
  expect(() => BackupRecoveryDigest.make(new Uint8Array(31))).toThrow();
  expect(() =>
    BackupRecoveryCredential.make({
      _tag: "Consumed",
      userId,
      consumedAt: DateTime.add(createdAt, { milliseconds: -1 }),
      consumedByCaseId: Option.some(caseId),
      revision: 1,
      createdAt,
    })
  ).toThrow();
});

it("models terminal SupportRecoveryCases and only closed metadata event combinations", () => {
  const pairingId = BrowserLoginPairingId.make("f1d1a000-0000-4000-8000-000000000904");
  const operatorId = SupportOperatorId.make({
    issuer: "https://fidy.cloudflareaccess.com",
    subject: "operator-42",
  });
  const supportCase = SupportRecoveryCase.make({
    id: caseId,
    userId,
    pairingId,
    credentialRevision: 1,
    lifecycle: "expired",
    openedAt: createdAt,
    expiresAt: DateTime.add(createdAt, { minutes: 10 }),
    closedAt: DateTime.add(createdAt, { minutes: 10 }),
  });
  const event = SupportRecoveryCaseEvent.make({
    id: SupportRecoveryCaseEventId.make("f1d1a000-0000-4000-8000-000000000905"),
    caseId,
    ordinal: 1,
    occurredAt: createdAt,
    actor: { _tag: "Operator", operatorId },
    action: "open",
    outcome: "accepted",
  });

  const openCase = SupportRecoveryCase.make({
    id: caseId,
    userId,
    pairingId,
    credentialRevision: 1,
    lifecycle: "open",
    openedAt: createdAt,
    expiresAt: DateTime.add(createdAt, { minutes: 10 }),
  });

  expect(supportCase.lifecycle).toBe("expired");
  expect(openCase.lifecycle).toBe("open");
  expect(() =>
    SupportRecoveryCase.make({
      id: caseId,
      userId,
      pairingId,
      credentialRevision: 1,
      lifecycle: "expired",
      openedAt: createdAt,
      expiresAt: createdAt,
      closedAt: createdAt,
    })
  ).toThrow();
  expect(() =>
    SupportRecoveryCase.make({
      id: caseId,
      userId,
      pairingId,
      credentialRevision: 1,
      lifecycle: "expired",
      openedAt: createdAt,
      expiresAt: supportCase.expiresAt,
      closedAt: DateTime.add(supportCase.expiresAt, { milliseconds: 1 }),
    })
  ).toThrow();
  expect(() =>
    SupportRecoveryCase.make({
      id: caseId,
      userId,
      pairingId,
      credentialRevision: 1,
      lifecycle: "expired",
      openedAt: createdAt,
      expiresAt: supportCase.expiresAt,
      closedAt: DateTime.add(createdAt, { milliseconds: -1 }),
    })
  ).toThrow();
  expect(event).toMatchObject({ action: "open", outcome: "accepted" });
  expect(() =>
    Schema.decodeUnknownSync(SupportRecoveryCaseEvent)({
      ...event,
      action: "approve",
      outcome: "rejected",
    })
  ).toThrow();
});
