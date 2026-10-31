import { Schema } from "effect";

export const CutoverHistory = Schema.fromJsonString(
  Schema.Struct({
    originalDefinitions: Schema.Array(Schema.String),
    introducedNames: Schema.Array(Schema.String),
  })
);

export const schemaStatements = (source: string): ReadonlyArray<string> =>
  source
    .split("--> statement-breakpoint")
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0);

export const schemaObjectName = (sql: string): string =>
  /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER|VIEW) "?(\w+)"?/u.exec(sql)?.[1] ?? "";

export const schemaDefinition = ({
  source,
  target,
}: Readonly<{ source: ReadonlyArray<string>; target: string }>): string => {
  const found = source.find((sql) => schemaObjectName(sql) === target);
  if (found === undefined) throw Error("Missing cutover source definition");
  return found;
};

export const precedingSchema = ({
  current,
  history,
}: Readonly<{
  current: ReadonlyArray<string>;
  history: Readonly<{
    originalDefinitions: ReadonlyArray<string>;
    introducedNames: ReadonlyArray<string>;
  }>;
}>): ReadonlyArray<string> => {
  const original = new Map(history.originalDefinitions.map((sql) => [schemaObjectName(sql), sql]));
  const names = new Set(current.map(schemaObjectName));
  const restored = [
    ...current
      .filter((sql) => !history.introducedNames.includes(schemaObjectName(sql)))
      .map((sql) => original.get(schemaObjectName(sql)) ?? sql)
      .map((sql) =>
        schemaObjectName(sql) === "erasure_requests" && !sql.includes("decision_json")
          ? sql.replace(
              "CREATE TABLE erasure_requests (",
              "CREATE TABLE erasure_requests (\n  decision_json TEXT,"
            )
          : sql
      ),
    ...history.originalDefinitions.filter((sql) => !names.has(schemaObjectName(sql))),
  ];
  if (!restored.some((sql) => schemaObjectName(sql) === "erasure_archives")) {
    restored.push(...historicalErasureStorage);
  }
  // Removed parent tables must exist before their restored triggers and indexes.
  return [
    ...restored.filter((sql) => sql.startsWith("CREATE TABLE ")),
    ...restored.filter((sql) => !sql.startsWith("CREATE TABLE ")),
  ];
};

/** Explicit pre-full-deletion source records for populated historical migration rehearsals. */
const historicalErasureStorage = [
  `CREATE TABLE erasure_archives (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  store_id TEXT NOT NULL,
  row_ref TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(body)<=1048576),
  recovery_written INTEGER NOT NULL DEFAULT 0 CHECK(recovery_written IN(0,1)),
  PRIMARY KEY(request_id,store_id,row_ref)
) STRICT;`,
  `CREATE TABLE erasure_objects (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  bucket TEXT NOT NULL CHECK(bucket IN ('email','statement')),
  object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
  retained_key TEXT,
  recovery_written INTEGER NOT NULL DEFAULT 0 CHECK(recovery_written IN(0,1)),
  held_deleted INTEGER NOT NULL DEFAULT 0 CHECK(held_deleted IN(0,1)),
  missing INTEGER NOT NULL DEFAULT 0 CHECK(missing IN (0,1)),
  done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
  PRIMARY KEY(request_id,bucket,object_key)
) STRICT;`,
];
