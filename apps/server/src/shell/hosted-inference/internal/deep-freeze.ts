/** Recursively freezes a structured-clone-compatible value in place. */
export const freezeDeep: <A>(value: A) => A = (value) => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
};
