export const requireArgument = (name: string): string => {
  const index = Bun.argv.indexOf(`--${name}`);
  const value = Bun.argv[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} is required`);
  }
  return value;
};
