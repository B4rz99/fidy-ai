import type { StatementSourceFormat } from "~/core/ingestion/reference";

const zipFirstByte = 0x50;
const zipSecondByte = 0x4b;

/** Base64 signatures of common non-tabular uploads; content decides, never a claimed type. */
const unsupportedSignatures = ["JVBERg==", "iVBORw==", "/9j/", "R0lGOA==", "Qk0=", "UklGRg=="].map(
  (signature) => Uint8Array.fromBase64(signature)
);
// Encrypted Office documents use OLE Compound File, not the ZIP container of supported XLSX.
const protectedOfficeSignature = Uint8Array.fromBase64("0M8R4KGxGuE=");

const startsWith = (bytes: Uint8Array, signature: Uint8Array): boolean =>
  signature.every((value, index) => bytes[index] === value);

/**
 * True when the leading bytes identify an unsupported format — PDF, protected Office documents,
 * PNG, JPEG, GIF, BMP, or RIFF/WebP. Staging and parsing share this gate, so a mismatched claim cannot decide
 * whether hostile content is admitted.
 */
export const knownUnsupportedStatementBytes = (bytes: Uint8Array): boolean =>
  unsupportedSignatures.some((signature) => startsWith(bytes, signature)) ||
  startsWith(bytes, protectedOfficeSignature);

/** Sniffs the deterministic parser from uploaded bytes rather than untrusted MIME metadata. */
export const statementSourceFormat = (bytes: Uint8Array): StatementSourceFormat =>
  bytes.slice(0, 2).join(",") === `${zipFirstByte},${zipSecondByte}` ? "xlsx" : "csv";
