import { Function } from "effect";

/** Match one HttpApi route template; a parameter accepts exactly one nonempty path segment. */
export const matchesRoute = Function.dual<
  (path: string) => (template: string) => boolean,
  (template: string, path: string) => boolean
>(2, (template, path) => {
  const segments = template.split("/");
  const supplied = path.split("/");
  return (
    segments.length === supplied.length &&
    segments.every((segment, index) =>
      segment.startsWith(":") ? supplied[index] !== "" : segment === supplied[index]
    )
  );
});
