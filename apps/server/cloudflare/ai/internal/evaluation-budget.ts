import { type Cause, Clock, Effect, Option, Schema } from "effect";
import {
  HostedInferenceError,
  type WorkersAiRequest,
  type WorkersAiRun,
  approvedWorkersAiModel,
} from "../../../src/shell/hosted-inference/contract";
import type { WorkersAiEnvironment } from "../contract";
import { adversarialCorpus, repetitions } from "./adversarial-corpus";

const maximumRequestBytes = 65_536;
const maximumOutputTokens = 16_000;
export const evaluationLimits = {
  providerCalls: adversarialCorpus.length * repetitions,
  requestBytes: maximumRequestBytes,
  totalRequestBytes: adversarialCorpus.length * repetitions * maximumRequestBytes,
  outputTokensPerCall: maximumOutputTokens,
  totalOutputTokens: adversarialCorpus.length * repetitions * maximumOutputTokens,
  elapsedMillis: 1_200_000,
} as const;
export type EvaluationEnvironment = WorkersAiEnvironment &
  Readonly<{
    EVALUATION_TOKEN: string;
    EVALUATION_COMMIT: string;
    EVALUATION_MODE: "dry-run" | "live";
  }>;
type BudgetSnapshot = Readonly<{
  reservedCalls: number;
  inputBytes: number;
  reservedOutputTokens: number;
  requestEvidence: Readonly<{ sha256: string; bytes: number; maxTokens: number }>;
}>;
export type EvaluationBudget = Readonly<{ run: WorkersAiRun; snapshot: () => BudgetSnapshot }>;
export const evidenceHash = (text: string): Effect.Effect<string, Cause.UnknownError> =>
  Effect.tryPromise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((bytes) => {
      const hexadecimalRadix = 16;
      return Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(hexadecimalRadix).padStart(2, "0")
      ).join("");
    })
  );
const withinBudget = (state: BudgetSnapshot, bytes: number, request: WorkersAiRequest): boolean =>
  state.reservedCalls < evaluationLimits.providerCalls &&
  bytes <= evaluationLimits.requestBytes &&
  state.inputBytes + bytes <= evaluationLimits.totalRequestBytes &&
  request.max_tokens === evaluationLimits.outputTokensPerCall &&
  state.reservedOutputTokens + request.max_tokens <= evaluationLimits.totalOutputTokens;
const refused = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "ResourceLimit" },
    retryable: false,
    retryAfter: Option.none(),
  });
const dryResponse = (): Response =>
  Response.json({
    choices: [
      {
        message: { role: "assistant", content: "Synthetic dry-run; not model evidence." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
/** One process lifetime; reserves worst-case output before egress and never refunds failed calls. */
export const makeEvaluationBudget = (environment: EvaluationEnvironment): EvaluationBudget => {
  let state: BudgetSnapshot = {
    reservedCalls: 0,
    inputBytes: 0,
    reservedOutputTokens: 0,
    requestEvidence: { sha256: "", bytes: 0, maxTokens: 0 },
  };
  let deadline: Option.Option<number> = Option.none();
  const run: WorkersAiRun = (model, request) =>
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      if (Option.isNone(deadline)) {
        deadline = Option.some(current + evaluationLimits.elapsedMillis);
      }
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        request
      ).pipe(Effect.mapError(refused));
      const bytes = new TextEncoder().encode(encoded).length;
      if (
        !withinBudget(state, bytes, request) ||
        current >= Option.getOrElse(deadline, () => current) ||
        model !== approvedWorkersAiModel
      ) {
        return yield* refused();
      }
      // Reservation precedes every asynchronous step, including hashing and native dispatch.
      state = {
        ...state,
        reservedCalls: state.reservedCalls + 1,
        inputBytes: state.inputBytes + bytes,
        reservedOutputTokens: state.reservedOutputTokens + request.max_tokens,
      };
      const sha256 = yield* evidenceHash(encoded);
      state = {
        ...state,
        requestEvidence: {
          sha256,
          bytes,
          maxTokens: request.max_tokens,
        },
      };
      if (environment.EVALUATION_MODE === "dry-run") {
        return dryResponse();
      }
      return yield* Effect.tryPromise((signal) =>
        environment.AI.run(model, request, { returnRawResponse: true, signal })
      );
    });
  return { run, snapshot: (): BudgetSnapshot => state };
};
