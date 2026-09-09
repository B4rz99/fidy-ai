import { describe, expect, it } from "@effect/vitest";
import {
  type MistralV13Messages,
  countMistralV13Messages,
  encodeMistralV13Messages,
} from "./mistral-tokenizer";

const tokenDigest = (tokens: ReadonlyArray<number>): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(tokens)).digest("hex");

describe("Mistral tokenizer", () => {
  it("reproduces the official structured-output example's 23 message tokens", () => {
    const messages: MistralV13Messages = [
      { role: "system", content: "Extract the books information." },
      {
        role: "user",
        content: "I recently read To Kill a Mockingbird by Harper Lee.",
      },
    ];
    const tokens = encodeMistralV13Messages(messages);

    expect(countMistralV13Messages(messages)).toBe(23);
    expect(tokenDigest(tokens)).toBe(
      "0c467ee75e8ba4f12d9432ce82ee20d931a6f99d7b24547366eba1cb2a93c642"
    );
  });

  it("matches independent Bun Hugging Face vectors for es-CO Unicode text", () => {
    const tokens = encodeMistralV13Messages([
      {
        role: "system",
        content: "Conserva continuidad financiera, no inventes hechos.",
      },
      {
        role: "user",
        content:
          "Resumí: pagué $48.900 en Éxito y después recibí una devolución de $12.300. ¿Cuánto gasté neto? 🇨🇴",
      },
    ]);

    expect(tokens).toHaveLength(65);
    expect(tokenDigest(tokens)).toBe(
      "3c96fc68f1c50da14a37aa7170a6a4df0617936578cb31d03d7d1f212c5c8ce8"
    );
  });
});
