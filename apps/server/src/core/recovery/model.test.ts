import { expect, it } from "@effect/vitest";
import { DateTime, Redacted } from "effect";
import { UserId } from "~/core/identity/reference";
import { BackupRecoveryCode, BackupRecoveryCredential } from "./model";

it("models a one-time raw BackupRecoveryCode outside its digest-only credential", () => {
  const raw = Redacted.make(BackupRecoveryCode.make("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2"));
  const credential = BackupRecoveryCredential.make({
    userId: UserId.make("f1d1a000-0000-4000-8000-000000000902"),
    codeDigest: new Uint8Array(32),
    createdAt: DateTime.makeUnsafe("2026-08-23T12:00:00Z"),
  });

  expect(Redacted.value(raw)).toBe("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2");
  expect(credential).not.toHaveProperty("code");
  expect(credential.codeDigest).toHaveLength(32);
  expect(() =>
    BackupRecoveryCredential.make({ ...credential, codeDigest: new Uint8Array(31) })
  ).toThrow();
});
