import { Option, Schema } from "effect";

/**
 * The stable id the final segment of this request's path addresses, decoded by that id's own
 * schema, or None when the segment is absent or is not a stable identity.
 */
export const pathId = <A extends Schema.ConstraintDecoder<unknown>>({
  schema,
  request,
}: Readonly<{
  schema: A;
  request: Request;
}>): Option.Option<A["Type"]> =>
  Option.flatMap(Option.fromUndefinedOr(new URL(request.url).pathname.split("/").at(-1)), (raw) =>
    Schema.decodeOption(schema)(raw)
  );

/**
 * The final path segment exactly as it arrived, undecoded, for a route that must forward an
 * unstable id instead of answering for it. The empty string stands for a path that carries no
 * segment at all; both spellings reach the owner, which is the only place that decides whether
 * the id is a retained one. Prefer `pathId` when the route itself answers 404 for an id that is
 * not a stable identity.
 */
export const rawPathId = ({ request }: Readonly<{ request: Request }>): string =>
  new URL(request.url).pathname.split("/").at(-1) ?? "";
