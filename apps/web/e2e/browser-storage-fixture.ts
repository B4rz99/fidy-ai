/** Count every stored entry except the Router's strictly numeric, session-scoped scroll cache. */
export const retainedSecretCount = (): number => {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const position = (value: unknown): boolean =>
    record(value) &&
    Object.keys(value).length === 2 &&
    typeof value.scrollX === "number" &&
    Number.isFinite(value.scrollX) &&
    typeof value.scrollY === "number" &&
    Number.isFinite(value.scrollY);
  const scroll = sessionStorage.getItem("tsr-scroll-restoration-v1_3");
  const total = localStorage.length + sessionStorage.length;
  if (scroll === null) return total;
  const cache: unknown = JSON.parse(scroll);
  const valid =
    record(cache) &&
    Object.entries(cache).every(
      ([key, elements]) =>
        /^(?:none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):[a-z0-9]+$/u.test(
          key
        ) &&
        record(elements) &&
        Object.entries(elements).every(
          ([selector, value]) =>
            (selector === "window" ||
              /^[a-z][a-z0-9-]*:nth-child\(\d+\)(?: > [a-z][a-z0-9-]*:nth-child\(\d+\))*$/u.test(
                selector
              )) &&
            position(value)
        )
    );
  return total - Number(valid);
};
