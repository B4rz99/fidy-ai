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
