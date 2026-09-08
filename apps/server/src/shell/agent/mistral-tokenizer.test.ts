import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "@effect/vitest";
import { ministral3bVocabulary } from "./fixtures/ministral-3b-2512-vocabulary";
import {
  type MistralStructuredCountedRequest,
  countMistralStructuredRequest,
  encodeMistralStructuredRequest,
} from "./mistral-tokenizer";

const schema = {
  type: "json_schema",
  json_schema: {
    name: "book",
    strict: true,
    schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
} as const;

const request = (
  messages: MistralStructuredCountedRequest["messages"]
): MistralStructuredCountedRequest => ({ messages, response_format: schema });

const tokenDigest = (tokens: ReadonlyArray<number>): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(tokens)).digest("hex");

describe("Mistral tokenizer", () => {
  it("retains the pinned transformed Ministral 3 3B vocabulary", () => {
    const compressed = Buffer.from(ministral3bVocabulary.gzipBase64, "base64");
    expect(new Bun.CryptoHasher("sha256").update(compressed).digest("hex")).toBe(
      "8befe274efff10d098b3b15ded36b6bbe095546bde808ccbf1d78a0e06dbdfcc"
    );
    expect(new Bun.CryptoHasher("sha256").update(gunzipSync(compressed)).digest("hex")).toBe(
      "a437159c587e82ed8fc7e0dc7cfd0df5db0e3eccd323ce718bdcb0c0b3674bcf"
    );
  });

  it("matches the official structured-output example's 23 prompt tokens", () => {
    const tokens = encodeMistralStructuredRequest(
      request([
        { role: "system", content: "Extract the books information." },
        {
          role: "user",
          content: "I recently read To Kill a Mockingbird by Harper Lee.",
        },
      ])
    );

    expect(tokens).toHaveLength(23);
    expect(tokenDigest(tokens)).toBe(
      "0c467ee75e8ba4f12d9432ce82ee20d931a6f99d7b24547366eba1cb2a93c642"
    );
  });

  it("matches independent Bun Hugging Face vectors for es-CO Unicode text", () => {
    const tokens = encodeMistralStructuredRequest(
      request([
        {
          role: "system",
          content: "Conserva continuidad financiera, no inventes hechos.",
        },
        {
          role: "user",
          content:
            "Resumí: pagué $48.900 en Éxito y después recibí una devolución de $12.300. ¿Cuánto gasté neto? 🇨🇴",
        },
      ])
    );

    expect(tokens).toHaveLength(65);
    expect(tokenDigest(tokens)).toBe(
      "3c96fc68f1c50da14a37aa7170a6a4df0617936578cb31d03d7d1f212c5c8ce8"
    );
  });

  it("matches independent role-framing vectors across continued conversation", () => {
    const tokens = encodeMistralStructuredRequest(
      request([
        { role: "system", content: "Responde en español de Colombia." },
        { role: "user", content: "Compré mercado por COP 75.250." },
        {
          role: "assistant",
          content: "Registraste una compra de mercado por COP 75.250.",
        },
        { role: "user", content: "También pagué transporte por COP 8.600." },
      ])
    );

    expect(tokens).toHaveLength(61);
    expect(tokenDigest(tokens)).toBe(
      "3b00a9437c0a0dd4269b6bc4a983d19348c793ac7078dd6452c547af6effb715"
    );
  });

  it("keeps strict JSON Schema out of hosted prompt accounting", () => {
    const messages = [{ role: "user", content: "Devuelve el resultado." }] as const;
    const small = request(messages);
    const large: MistralStructuredCountedRequest = {
      messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "large",
          strict: true,
          schema: {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 100 }, (_, index) => [`field_${index}`, { type: "string" }])
            ),
            additionalProperties: false,
          },
        },
      },
    };

    expect(countMistralStructuredRequest(small)).toBe(countMistralStructuredRequest(large));
  });
});
