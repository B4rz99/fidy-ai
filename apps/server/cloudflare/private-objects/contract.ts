import { Data, Schema } from "effect";
import type { Effect, Option } from "effect";

export class PrivateObjectUnavailable extends Data.TaggedError("PrivateObjectUnavailable")<{
  readonly cause: Option.Option<unknown>;
}> {}

export type PrivateObjectBucket = Readonly<{
  put: (key: string, bytes: Uint8Array, options: R2PutOptions) => ReturnType<R2Bucket["put"]>;
  delete: (key: string) => ReturnType<R2Bucket["delete"]>;
}>;

export type PrivateObjectWrite<E, R> = Readonly<{
  bucket: PrivateObjectBucket;
  userId: string;
  key: string;
  bytes: Uint8Array;
  metadata: Readonly<Record<string, string>>;
  digest: Option.Option<Uint8Array>;
  predecessor: Option.Option<Readonly<{ etag: string; purpose: string }>>;
  authorise: Effect.Effect<boolean, E, R>;
}>;

const maximumPrivateObjectKeyLength = 1024;

export const PrivateObjectKey = Schema.String.check(
  Schema.isBetweenLength(1, maximumPrivateObjectKeyLength)
);
