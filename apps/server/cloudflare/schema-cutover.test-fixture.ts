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

export const documentedSqlBlock = ({
  guide,
  marker,
}: Readonly<{ guide: string; marker: string }>): ReadonlyArray<string> => {
  const value = guide.match(
    new RegExp(
      `<!-- ${marker}:start -->\\s*\x60\x60\x60sql\\s*([\\s\\S]*?)\x60\x60\x60\\s*<!-- ${marker}:end -->`,
      "u"
    )
  )?.[1];
  if (value === undefined) throw Error("Missing documented cutover block");
  return value
    .split(";")
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0);
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
      .map((sql) => original.get(schemaObjectName(sql)) ?? sql),
    ...history.originalDefinitions.filter((sql) => !names.has(schemaObjectName(sql))),
  ];
  // Removed parent tables must exist before their restored triggers and indexes.
  return [
    ...restored.filter((sql) => sql.startsWith("CREATE TABLE ")),
    ...restored.filter((sql) => !sql.startsWith("CREATE TABLE ")),
  ];
};

type SchemaSwap = Readonly<{
  db: D1Database;
  source: ReadonlyArray<string>;
  target: ReadonlyArray<string>;
  sourceNames: ReadonlyArray<string>;
  targetNames: ReadonlyArray<string>;
}>;
type SchemaCutover = Readonly<{
  scratch: (source: ReadonlyArray<string>, names: ReadonlyArray<string>) => ReadonlyArray<string>;
  swap: (input: SchemaSwap) => ReadonlyArray<D1PreparedStatement>;
}>;

/** Shared native DDL mechanics; each rehearsal supplies its owner tables, guards and copy SQL. */
export const makeSchemaCutover = (tables: ReadonlyArray<string>): SchemaCutover => {
  const related = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
    source.filter(
      (sql) =>
        !sql.startsWith("CREATE TABLE ") &&
        tables.some((table) => new RegExp(`\\b${table}\\b`, "u").test(sql))
    );
  const objectType = (sql: string): string => {
    if (sql.startsWith("CREATE TRIGGER ")) return "TRIGGER";
    if (sql.startsWith("CREATE VIEW ")) return "VIEW";
    return "INDEX";
  };
  return {
    scratch: (source: ReadonlyArray<string>, names: ReadonlyArray<string>): ReadonlyArray<string> =>
      names.map((target) => {
        let sql = schemaDefinition({ source, target });
        for (const name of names) {
          sql = sql.replace(new RegExp(`\\b${name}\\b`, "gu"), `cutover_${name}`);
        }
        return sql;
      }),
    swap: ({
      db,
      source,
      target,
      sourceNames,
      targetNames,
    }: SchemaSwap): ReadonlyArray<D1PreparedStatement> => [
      ...related(source).map((sql) =>
        db.prepare(`DROP ${objectType(sql)} ${schemaObjectName(sql)}`)
      ),
      ...sourceNames.map((name) => db.prepare(`DROP TABLE ${name}`)),
      ...targetNames.map((name) => db.prepare(`ALTER TABLE cutover_${name} RENAME TO ${name}`)),
      ...related(target).map((sql) => db.prepare(sql)),
    ],
  };
};

/** Original transient selection table, explicitly restored only by pre-#1488 migration rehearsals. */
export const installHistoricalErasureChunk = (db: D1Database): Promise<D1Result> =>
  db
    .prepare(`CREATE TABLE erasure_chunk (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  row_ref TEXT NOT NULL,
  PRIMARY KEY(request_id,row_ref)
) STRICT;`)
    .run();
