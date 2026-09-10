import { Crypto, Effect, Encoding, FileSystem, Schema } from "effect";
import { Corpus, Coverage, EvaluationFailure } from "./model";

const corpusRoot = "src/shell/testing/evaluation/corpora/es-co-v1";
const maximumFixtureBytes = 1_000_000;
/** No caller-selected file paths or remotely supplied image references enter the corpus. */
export const imageNames = [
  "receipt.png",
  "receipt.jpeg",
  "receipt.gif",
  "receipt.webp",
  "injection.png",
] as const;
export type ImageName = (typeof imageNames)[number];

/** The corpus holds only synthetic financial prose; images remain private to scenario execution. */
export type LoadedCorpus = Readonly<{
  corpus: Corpus;
  sha256: string;
  images: ReadonlyMap<ImageName, Uint8Array>;
}>;

/** Hashes complete bounded bytes, not an unstable JSON representation of decoded domain values. */
export const sha256 = Effect.fn("Evaluation.sha256")(function* (bytes: Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  return Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes));
});

const readBounded = Effect.fn("Evaluation.readBounded")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(path);
  if (stat.size > BigInt(maximumFixtureBytes)) {
    return yield* new EvaluationFailure({ reason: "invalid-corpus" });
  }
  const bytes = yield* fs.readFile(path);
  if (bytes.length > maximumFixtureBytes) {
    return yield* new EvaluationFailure({ reason: "invalid-corpus" });
  }
  return bytes;
});

/** Rejects duplicate identities and missing promised coverage before any model is constructed. */
export const validateCoverage = (corpus: Corpus): Effect.Effect<void, EvaluationFailure> => {
  const ids = new Set(corpus.cases.map((entry) => entry.id));
  const covered = new Set(corpus.cases.flatMap((entry) => entry.coverage));
  const complete = Coverage.literals.every((label) => covered.has(label));
  return ids.size === corpus.cases.length && complete
    ? Effect.void
    : Effect.fail(new EvaluationFailure({ reason: "invalid-corpus" }));
};

/** Loads and hashes the manifest plus every admitted image byte before running any scenario. */
export const loadCorpus = Effect.gen(function* () {
  const bytes = yield* readBounded(`${corpusRoot}/corpus.json`);
  const corpus = yield* Schema.decodeEffect(Schema.fromJsonString(Corpus))(
    new TextDecoder().decode(bytes)
  );
  yield* validateCoverage(corpus);
  const hashes = [awaitedEntry("corpus.json", yield* sha256(bytes))];
  const images = new Map<ImageName, Uint8Array>();
  for (const name of imageNames) {
    const image = yield* readBounded(`${corpusRoot}/${name}`);
    images.set(name, image);
    hashes.push(awaitedEntry(name, yield* sha256(image)));
  }
  const digest = yield* sha256(new TextEncoder().encode(hashes.join("\n")));
  return { corpus, sha256: digest, images } satisfies LoadedCorpus;
}).pipe(Effect.mapError(() => new EvaluationFailure({ reason: "invalid-corpus" })));

const awaitedEntry = (path: string, hash: string): string => `${path}:${hash}`;

const readSourceEvidence = Effect.fn("Evaluation.readSourceEvidence")(function* (
  generationSourcePath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const sourcePaths = (yield* fs.readDirectory("src", { recursive: true }))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .map((path) => `src/${path}`);
  const paths = [...sourcePaths, "scripts/evaluate-es-co-openai.ts", "scripts/evaluate-es-co.sh"];
  const hashes: Array<string> = [];
  for (const path of paths.toSorted()) {
    hashes.push(awaitedEntry(path, yield* sha256(yield* fs.readFile(path))));
  }
  const controls = yield* sha256(yield* fs.readFile(generationSourcePath));
  const contract = yield* sha256(yield* fs.readFile("contracts/operation-policy.json"));
  return {
    sourceSha256: yield* sha256(new TextEncoder().encode(hashes.join("\n"))),
    generationSha256: controls,
    contractSha256: contract,
  };
});

type SourceEvidence = Readonly<{
  sourceSha256: string;
  generationSha256: string;
  contractSha256: string;
}>;

/** Captures evaluator and selected provider-control bytes separately from Git identity. */
export const sourceEvidence = (
  generationSourcePath: string
): Effect.Effect<SourceEvidence, EvaluationFailure, Crypto.Crypto | FileSystem.FileSystem> =>
  readSourceEvidence(generationSourcePath).pipe(
    Effect.mapError(() => new EvaluationFailure({ reason: "harness-failed" }))
  );
