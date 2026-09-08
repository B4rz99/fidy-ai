import { describe, expect, it } from "bun:test";
import { downloadBoundedSource, readBoundedBody } from "./generate-vocabulary.mjs";

const tinyByteLimit = 5;

describe("Mistral vocabulary source", () => {
  it("rejects declared and streamed bodies beyond the byte limit", async () => {
    await expect(
      readBoundedBody(
        new Response("small", { headers: { "content-length": "100" } }),
        tinyByteLimit
      )
    ).rejects.toThrow("byte limit");
    await expect(readBoundedBody(new Response("six!!!"), tinyByteLimit)).rejects.toThrow(
      "byte limit"
    );
  });

  it("aborts a non-terminating download at its explicit deadline", async () => {
    const fetchImplementation = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });

    await expect(
      downloadBoundedSource("https://provider.example/vocabulary", {
        fetchImplementation,
        maximumBytes: tinyByteLimit,
        deadlineMilliseconds: tinyByteLimit,
      })
    ).rejects.toThrow("timed out");
  });
});
