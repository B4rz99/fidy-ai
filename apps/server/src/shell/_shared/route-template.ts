/**
 * Whether one concrete request path matches a canonical route template. `:param` segments match any
 * non-empty segment; every other segment must match exactly. Published slice route modules share
 * this so path ownership cannot drift between their adapters.
 */
export const matchesRouteTemplate = ({
  template,
  path,
}: Readonly<{ template: string; path: string }>): boolean => {
  const expected = template.split("/");
  const actual = path.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) =>
      segment.startsWith(":") ? (actual[index]?.length ?? 0) > 0 : segment === actual[index]
    )
  );
};
