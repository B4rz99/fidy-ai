export type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireRecord = (value: unknown, subject: string): UnknownRecord => {
  if (!isRecord(value)) throw new Error(`${subject} is missing`);
  return value;
};

export const requireArgument = (name: string): string => {
  const index = Bun.argv.indexOf(`--${name}`);
  const value = Bun.argv[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} is required`);
  }
  return value;
};
