import { Data, Schema } from "effect";
import type { Effect, Option } from "effect";

export class PrivateObjectUnavailable extends Data.TaggedError("PrivateObjectUnavailable") {}
export type PrivateObjectBucket = Readonly<{
  put: (key: string, bytes: Uint8Array, options: R2PutOptions) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
}>;
/** Keys and metadata are fixed owner projections. Authorization must recheck the exact live owner reservation after the placeholder settles. */
export type PrivateObjectWrite<E, R> = Readonly<{
  bucket: PrivateObjectBucket;
  key: string;
  bytes: Uint8Array;
  metadata: Readonly<Record<string, string>>;
  digest: Option.Option<Uint8Array>;
  predecessor: Option.Option<string>;
  authorise: Effect.Effect<boolean, E, R>;
}>;

const maximumPrivateObjectKeyLength = 1024;
/** Opaque locator from an exact User-owned retained record, never caller authority. */
export const PrivateObjectKey = Schema.String.check(
  Schema.isBetweenLength(1, maximumPrivateObjectKeyLength)
);
