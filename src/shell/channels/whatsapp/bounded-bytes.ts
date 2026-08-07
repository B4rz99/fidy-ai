/** Collects byte chunks up to a fixed total and materializes their exact concatenation. */
export const makeBoundedBytes = (
  maximumBytes: number
): { append(chunk: Uint8Array): boolean; materialize(): Uint8Array } => {
  const chunks: Array<Uint8Array> = [];
  let size = 0;

  return {
    append(chunk: Uint8Array): boolean {
      if (size + chunk.byteLength > maximumBytes) return false;
      chunks.push(chunk);
      size += chunk.byteLength;
      return true;
    },
    materialize(): Uint8Array {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    },
  };
};
