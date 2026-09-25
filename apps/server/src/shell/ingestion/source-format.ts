import type { StatementSourceFormat } from "~/core/ingestion/reference";

const zipFirstByte = 0x50;
const zipSecondByte = 0x4b;

/** Base64 signatures of common non-tabular uploads; content decides, never a claimed type. */
const unsupportedSignatures = ["JVBERg==", "iVBORw==", "/9j/", "R0lGOA==", "Qk0=", "UklGRg=="].map(
  (signature) => Uint8Array.fromBase64(signature)
);

const startsWith = (bytes: Uint8Array, signature: Uint8Array): boolean =>
  signature.every((value, index) => bytes[index] === value);

/**
 * True when the leading bytes identify a non-tabular document format — PDF, PNG, JPEG, GIF, BMP,
 * or RIFF/WebP. Staging and parsing share this gate, so a mismatched media claim cannot decide
 * whether hostile content is admitted.
 */
export const knownUnsupportedStatementBytes = (bytes: Uint8Array): boolean =>
  unsupportedSignatures.some((signature) => startsWith(bytes, signature));

/** Sniffs the deterministic parser from uploaded bytes rather than untrusted MIME metadata. */
export const statementSourceFormat = (bytes: Uint8Array): StatementSourceFormat =>
  bytes.slice(0, 2).join(",") === `${zipFirstByte},${zipSecondByte}` ? "xlsx" : "csv";
