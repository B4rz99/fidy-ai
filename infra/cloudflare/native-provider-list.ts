import { Effect, Schema } from "effect";

export type ProviderRead = (path: string) => Effect.Effect<unknown, Error>;

const Page = Schema.Struct({
  page: Schema.optional(Schema.Int),
  total_pages: Schema.optional(Schema.Int),
  total_count: Schema.optional(Schema.Int),
});

const limit = 100;

const finished = (info: typeof Page.Type, page: number, length: number): boolean =>
  info.total_pages === undefined ? length < limit : page >= info.total_pages;

const pageUrl = (path: string, page: number): string =>
  path +
  (path.includes("?") ? "&" : "?") +
  new URLSearchParams({ page: String(page), per_page: String(limit) });

const consistent = (expected: number, actual?: number): boolean =>
  actual === undefined || actual === expected;

export const readProviderList = Effect.fn(function* <Value>(
  read: ProviderRead,
  path: string,
  item: Schema.Codec<Value>
) {
  const rows: Value[] = [];

  const inventoryPage = Schema.Struct({
    success: Schema.Literal(true),
    result: Schema.Array(item),
    result_info: Schema.optional(Page),
  });

  for (let page = 1; page <= limit; page++) {
    const url = pageUrl(path, page);
    const body = yield* Schema.decodeUnknownEffect(inventoryPage)(yield* read(url));

    if (!consistent(page, body.result_info?.page)) {
      return yield* Effect.fail(Error("Provider returned an unexpected inventory page"));
    }

    rows.push(...body.result);

    if (finished(body.result_info ?? {}, page, body.result.length)) {
      if (!consistent(rows.length, body.result_info?.total_count)) {
        return yield* Effect.fail(Error("Provider returned an incomplete inventory"));
      }

      return rows;
    }
  }

  return yield* Effect.fail(Error("Provider inventory exceeds closed-release budget"));
});
