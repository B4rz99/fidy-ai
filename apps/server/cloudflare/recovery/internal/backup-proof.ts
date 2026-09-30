const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const symbolCount = 25;

export const sampleBackupCode = (): string =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(symbolCount)),
    (byte) => alphabet[byte % alphabet.length]
  )
    .join("")
    .match(/.{5}/gu)
    ?.join("-") ?? "";

export const digestBackupCode = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));
