import { BackupRecoveryCode } from "../../../src/core/recovery/contract";
import { Schema } from "effect";

const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const recoverySymbolCount = 25;

export const sampleRecoveryCode = (): BackupRecoveryCode =>
  Schema.decodeSync(BackupRecoveryCode)(
    Array.from(
      crypto.getRandomValues(new Uint8Array(recoverySymbolCount)),
      (byte) => recoveryAlphabet[byte % recoveryAlphabet.length]
    )
      .join("")
      .match(/.{5}/gu)
      ?.join("-") ?? ""
  );

export const recoveryCodeDigest = (value: BackupRecoveryCode): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));
