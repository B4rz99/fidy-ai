import { Predicate } from "effect";

export const freezeDeep: <A>(value: A) => A = (value) => {
  if (!(Predicate.isObject(value) || Array.isArray(value)) || Object.isFrozen(value)) return value;

  for (const child of Object.values(value)) freezeDeep(child);

  Object.freeze(value);

  return value;
};
