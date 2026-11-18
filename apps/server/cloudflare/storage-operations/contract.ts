import { Schema } from "effect";
import { StorageCommand } from "../../src/shell/storage-operations/contract";

export type { StorageCommand } from "../../src/shell/storage-operations/contract";
const maximumOperatorLength = 256;
export const localStorageOperatorUrl = "https://owner.internal/storage-operations";
export const StorageAdmission = Schema.Struct({
  command: StorageCommand,
  permission: Schema.Literals(["storage.inspect", "storage.repair"]),
  issuer: Schema.String.check(Schema.isMaxLength(maximumOperatorLength)),
  operator: Schema.String.check(Schema.isBetweenLength(1, maximumOperatorLength)),
  deadline: Schema.Int,
});
export const storagePermission = (
  command: StorageCommand
): typeof StorageAdmission.Type.permission =>
  command.action.startsWith("inspect") ? "storage.inspect" : "storage.repair";

export const operationEvidenceSchema = [
  "CREATE TABLE storage_operation_evidence(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,operator TEXT NOT NULL,action TEXT NOT NULL,family TEXT NOT NULL,target TEXT NOT NULL,occurred_ms INTEGER NOT NULL,outcome TEXT NOT NULL) STRICT",
  "CREATE INDEX storage_operation_target ON storage_operation_evidence(family,target)",
  "CREATE INDEX storage_operation_time ON storage_operation_evidence(occurred_ms)",
];
export const deleteTargetEvidence = ({
  family,
  table,
  column,
}: {
  family: string;
  table: string;
  column: string;
}): string =>
  `CREATE TRIGGER remove_operator_${family.replaceAll("-", "_")} AFTER DELETE ON ${table} BEGIN DELETE FROM storage_operation_evidence WHERE family='${family}' AND target=OLD.${column}; END`;
