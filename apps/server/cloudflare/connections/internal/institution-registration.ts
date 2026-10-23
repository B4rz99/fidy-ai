import type { InstitutionId } from "../../../src/core/connections/contract";

/** Static deployed registry only; neither request input nor database state supplies these IDs. */
export const registeredInstitutionPredicate = ({
  column,
  institutions,
}: Readonly<{ column: string; institutions: ReadonlyArray<InstitutionId> }>): string =>
  `${column} IN (${institutions.map((id) => `'${id.replaceAll("'", "''")}'`).join(",") || "NULL"})`;
