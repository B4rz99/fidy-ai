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

export const readUserObjects = Effect.fn(function* (read: ProviderRead, namespace: string) {
  const objects = new Map<string, boolean>();
  const seen = new Set<string>();
  let cursor = "";
  for (let page = 0; page < limit; page++) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== "") query.set("cursor", cursor);
    const response = yield* read(
      "workers/durable_objects/namespaces/" + encodeURIComponent(namespace) + "/objects?" + query
    );
    const data = yield* Schema.decodeUnknownEffect(Page)(response);
    for (const row of data.result) {
      if (objects.has(row.id)) return yield* Effect.fail(Error("Duplicate physical User object"));
      objects.set(row.id, row.hasStoredData);
    }
    cursor = data.result_info?.cursors?.after ?? data.result_info?.cursor ?? "";
    if (cursor === "" && data.result.length < limit) return objects;
    if (cursor === "" || seen.has(cursor))
      return yield* Effect.fail(Error("Incomplete physical User inventory"));
    seen.add(cursor);
  }
  return yield* Effect.fail(Error("Physical User inventory exceeds the release budget"));
});

const unchanged = (before: UserObjects, current: UserObjects): void => {
  for (const [id, stored] of before) {
    if (current.get(id) !== stored) throw Error("A retained physical User object changed");
  }
};
export const newStoredUser = (before: UserObjects, current: UserObjects): Option.Option<string> => {
  unchanged(before, current);
  const added = [...current.keys()].filter((id) => !before.has(id));
  if (added.length > 1) throw Error("Ambiguous physical User identity");
  const [id] = added;
  return id !== undefined && current.get(id) === true ? Option.some(id) : Option.none();
};
export const physicalErasure = (
  before: UserObjects,
  subject: string,
  current: UserObjects
): Option.Option<"absent" | "empty"> => {
  unchanged(before, current);
  if (before.has(subject) || [...current.keys()].some((id) => id !== subject && !before.has(id))) {
    throw Error("Physical User identity changed during erasure");
  }
  if (!current.has(subject)) return Option.some("absent");
  return current.get(subject) ? Option.none() : Option.some("empty");
};
