import { DateTime, Option } from "effect";

export const registryObject = (
  input: Readonly<{ key: string; etag: string; size: number; uploaded: number }>
): R2Object => ({
  key: input.key,
  version: input.etag,
  etag: input.etag,
  httpEtag: `"${input.etag}"`,
  size: input.size,
  uploaded: DateTime.toDateUtc(DateTime.makeUnsafe(input.uploaded)),
  checksums: { toJSON: () => ({}) },
  storageClass: "Standard",
  writeHttpMetadata: () => undefined,
});

export const registryBody = (
  input: Readonly<{ object: R2Object; value: string }>
): R2ObjectBody => {
  const { object, value } = input;
  const response = new Response(value);
  return {
    ...object,
    writeHttpMetadata: (headers) => object.writeHttpMetadata(headers),
    body: Option.getOrThrow(Option.fromNullOr(response.body)),
    get bodyUsed() {
      return response.bodyUsed;
    },
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
    blob: () => response.blob(),
    json: () => response.json(),
    bytes: () => response.bytes(),
  };
};
