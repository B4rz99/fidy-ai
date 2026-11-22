import { Effect, Option, Schema } from "effect";
import type { ProviderRead } from "./native-provider-list";

export type UserObjects = ReadonlyMap<string, boolean>;

const limit = 100;

const Cursor = Schema.optional(Schema.NullOr(Schema.String));

const Page = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
      hasStoredData: Schema.Boolean,
    })
  ),
  result_info: Schema.optional(
    Schema.Struct({
      cursor: Cursor,
      cursors: Schema.optional(Schema.NullOr(Schema.Struct({ after: Cursor }))),
    })
  ),
});

const pageCursor = (data: typeof Page.Type): string =>
  data.result_info?.cursors?.after ?? data.result_info?.cursor ?? "";

const appendRows = (objects: Map<string, boolean>, page: typeof Page.Type): void => {
  for (const row of page.result) {
    if (objects.has(row.id)) throw Error("Duplicate physical User object");
    objects.set(row.id, row.hasStoredData);
  }
};

export const readUserObjects = Effect.fn(function* (read: ProviderRead, namespace: string) {
  const objects = new Map<string, boolean>();

  const readFrom = (
    page: number,
    cursor: string,
    seen: ReadonlySet<string>
  ): Effect.Effect<Map<string, boolean>, Error> =>
    page >= limit
      ? Effect.fail(Error("Physical User inventory exceeds the release budget"))
      : Effect.gen(function* () {
          const query = new URLSearchParams({ limit: String(limit) });

          if (cursor !== "") query.set("cursor", cursor);

          const response = yield* read(
            "workers/durable_objects/namespaces/" +
              encodeURIComponent(namespace) +
              "/objects?" +
              query
          );

          const data = yield* Schema.decodeUnknownEffect(Page)(response);

          yield* Effect.try(() => appendRows(objects, data));

          const next = pageCursor(data);

          if (next === "" && data.result.length < limit) return objects;

          if (next === "" || seen.has(next)) {
            return yield* Effect.fail(Error("Incomplete physical User inventory"));
          }

          return yield* readFrom(page + 1, next, new Set([...seen, next]));
        });

  return yield* readFrom(0, "", new Set());
});

const unchanged = (before: UserObjects, current: UserObjects): void => {
  for (const [id, stored] of before) {
    if (current.get(id) !== stored) throw Error("A retained physical User object changed");
  }
};

type Census = { before: UserObjects; current: UserObjects };

export const newStoredUser = ({ before, current }: Census): Option.Option<string> => {
  unchanged(before, current);
  const added = [...current.keys()].filter((id) => !before.has(id));

  if (added.length > 1) throw Error("Ambiguous physical User identity");
  const [id] = added;

  return id !== undefined && current.get(id) === true ? Option.some(id) : Option.none();
};

export const physicalErasure = ({
  before,
  subject,
  current,
}: Census & { subject: string }): Option.Option<"absent" | "empty"> => {
  unchanged(before, current);

  if (before.has(subject) || [...current.keys()].some((id) => id !== subject && !before.has(id))) {
    throw Error("Physical User identity changed during erasure");
  }

  if (!current.has(subject)) return Option.some("absent");

  return current.get(subject) === true ? Option.none() : Option.some("empty");
};
