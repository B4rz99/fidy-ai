import type { StatementSourceFormat } from "~/core/ingestion/reference";

const zipFirstByte = 0x50;
const zipSecondByte = 0x4b;

/** Sniffs the deterministic parser from uploaded bytes rather than untrusted MIME metadata. */
export const statementSourceFormat = (bytes: Uint8Array): StatementSourceFormat =>
  bytes.slice(0, 2).join(",") === `${zipFirstByte},${zipSecondByte}` ? "xlsx" : "csv";
