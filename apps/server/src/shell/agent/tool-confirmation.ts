import { Crypto, DateTime, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";
import { type TranscriptEntry, TranscriptText } from "~/core/transcript/model";
import {
  type AtomicBatchInput,
  atomicBatchOperation,
  getAtomicBatchInputSchema,
} from "~/shell/operations/operations";
import { listRecentTranscriptEntries } from "~/shell/transcript/transcript-service";
import {
  ConfirmationDigest,
  type ConfirmationDigest as ConfirmationDigestType,
} from "./tool-confirmation-model";
import { consumeConfirmation } from "./tool-confirmation-repo";
import type { AgentOperationBinding } from "./toolkit";

const hexadecimalRadix = 16;
const confirmationNonceBytes = 32;
const confirmationLifetimeMinutes = 10;

const ConfirmationRequiredFailure = Schema.Struct({
  code: Schema.Literal("explicit_confirmation_required"),
  message: Schema.Literal(
    "Use the exact host-rendered confirmation command, including its operation id and digest."
  ),
  challenge: TranscriptText,
});
type ConfirmationRequiredFailure = typeof ConfirmationRequiredFailure.Type;

type ConfirmationSubject = Pick<
  Extract<TranscriptEntry, { readonly _tag: "CanonicalToolCallEntry" }>,
  "operation" | "input"
> &
  Readonly<{ issuedAt: DateTime.Utc }>;

type PendingConfirmation = ConfirmationSubject & Readonly<{ challenge: TranscriptText }>;
type ConfirmationSubmission = PendingConfirmation & Readonly<{ digest: ConfirmationDigestType }>;

type ConfirmationDecision =
  | { readonly _tag: "Execute" }
  | {
      readonly _tag: "RequireConfirmation";
      readonly failure: ConfirmationRequiredFailure;
    };

type TranscriptCallEntry = Extract<TranscriptEntry, { readonly _tag: "CanonicalToolCallEntry" }>;
type TranscriptResultEntry = Extract<
  TranscriptEntry,
  { readonly _tag: "CanonicalToolResultEntry" }
>;

const resultEntryAt = (
  entries: ReadonlyArray<TranscriptEntry>,
  index: number
): Option.Option<TranscriptResultEntry> =>
  Option.fromUndefinedOr(entries[index]).pipe(
    Option.filter(
      (entry): entry is TranscriptResultEntry => entry._tag === "CanonicalToolResultEntry"
    )
  );

const confirmationFailure = (
  result: TranscriptResultEntry,
  challenge: string
): Option.Option<ConfirmationRequiredFailure> =>
  result.outcome._tag === "ToolInputRejected"
    ? Option.some(result.outcome.failure).pipe(
        Option.filter(Schema.is(ConfirmationRequiredFailure)),
        Option.filter((failure) => failure.challenge === challenge)
      )
    : Option.none();

const matchingCallBefore = (
  entries: ReadonlyArray<TranscriptEntry>,
  resultIndex: number,
  result: TranscriptResultEntry
): Option.Option<TranscriptCallEntry> =>
  Option.fromUndefinedOr(
    entries
      .slice(0, resultIndex)
      .filter((entry): entry is TranscriptCallEntry => entry._tag === "CanonicalToolCallEntry")
      .findLast((call) => call.toolCallId === result.toolCallId)
  );

const pendingConfirmationAt = (
  entries: ReadonlyArray<TranscriptEntry>,
  resultIndex: number,
  challenge: string
): Option.Option<PendingConfirmation> =>
  Option.gen(function* () {
    const result = yield* resultEntryAt(entries, resultIndex);
    yield* confirmationFailure(result, challenge);
    const call = yield* matchingCallBefore(entries, resultIndex, result);
    return {
      operation: call.operation,
      input: call.input,
      challenge: TranscriptText.make(challenge),
      issuedAt: result.occurredAt,
    };
  });

const findPendingConfirmation = (
  entries: ReadonlyArray<TranscriptEntry>
): Option.Option<PendingConfirmation> => {
  const assistant = entries.at(-1);
  if (assistant?._tag !== "AssistantTranscriptEntry") return Option.none();

  for (let index = entries.length - 1; index > 0; index -= 1) {
    const pending = pendingConfirmationAt(entries, index, assistant.text);
    if (Option.isSome(pending)) return pending;
  }
  return Option.none();
};

const canonicalJsonString = (value: Schema.Json): string =>
  Option.getOrThrow(
    Option.fromNullishOr(
      JSON.stringify(value, (_key, nested: unknown) =>
        typeof nested === "object" && nested !== null && !Array.isArray(nested)
          ? Object.fromEntries(
              Object.entries(nested).toSorted(([left], [right]) => left.localeCompare(right))
            )
          : nested
      )
    )
  );

const matchesConfirmationSubject = (
  pending: Readonly<PendingConfirmation>,
  binding: Readonly<AgentOperationBinding>,
  input: Schema.Json
): boolean =>
  pending.operation === binding.operation &&
  canonicalJsonString(pending.input) === canonicalJsonString(input);

const atomicBatchInput = (
  pending: Readonly<ConfirmationSubject>
): Option.Option<AtomicBatchInput> => {
  if (pending.operation !== atomicBatchOperation) return Option.none();
  const agentInput = Schema.Struct({ payload: getAtomicBatchInputSchema() });
  return Schema.decodeUnknownOption(agentInput)(pending.input).pipe(
    Option.map(({ payload }) => payload)
  );
};

const renderAtomicBatch = (pending: Readonly<ConfirmationSubject>): Option.Option<string> =>
  atomicBatchInput(pending).pipe(
    Option.map(({ calls }) =>
      calls
        .map(
          (call, index) =>
            `${index + 1}. ${call.operation}\n   Argumentos exactos: ${JSON.stringify(call.input)}`
        )
        .join("\n")
    )
  );

const confirmationBinding = Effect.fn("ToolConfirmation.confirmationBinding")(function* (
  pending: Readonly<ConfirmationSubject>
) {
  const crypto = yield* Crypto.Crypto;
  const serializedInput = canonicalJsonString(pending.input);
  const nonce = yield* crypto.randomBytes(confirmationNonceBytes).pipe(Effect.orDie);
  const nonceHex = Array.from(nonce, (byte) =>
    byte.toString(hexadecimalRadix).padStart(2, "0")
  ).join("");
  const payload = new TextEncoder().encode(`${pending.operation}\n${serializedInput}\n${nonceHex}`);
  const bytes = yield* crypto.digest("SHA-256", payload).pipe(Effect.orDie);
  const digest = ConfirmationDigest.make(
    Array.from(bytes, (byte) => byte.toString(hexadecimalRadix).padStart(2, "0")).join("")
  );
  return { digest, serializedInput };
});

type ConfirmationFormat = Readonly<{
  commandPrefix: string;
  challengeBody: string;
}>;

const confirmationFormat = (
  pending: Readonly<ConfirmationSubject>,
  serializedInput: string
): ConfirmationFormat =>
  renderAtomicBatch(pending).pipe(
    Option.match({
      onNone: () => ({
        commandPrefix: `CONFIRMAR ${pending.operation} `,
        challengeBody:
          `Esta operación requiere confirmación.\n` +
          `Operación exacta: ${pending.operation}\n` +
          `Argumentos exactos: ${serializedInput}`,
      }),
      onSome: (calls) => ({
        commandPrefix: "CONFIRMAR LOTE ",
        challengeBody:
          `Este lote atómico requiere una sola confirmación. Se ejecutará exactamente en este orden:\n` +
          calls,
      }),
    })
  );

const confirmationChallenge = (
  pending: Readonly<ConfirmationSubject>,
  digest: ConfirmationDigestType,
  serializedInput: string
): TranscriptText => {
  const format = confirmationFormat(pending, serializedInput);
  return TranscriptText.make(
    `${format.challengeBody}\nResponde exactamente: ${format.commandPrefix}${digest}`
  );
};

const authorizationFromChallenge = (
  pending: Readonly<PendingConfirmation>
): Option.Option<Readonly<{ command: string; digest: ConfirmationDigestType }>> => {
  const { commandPrefix } = confirmationFormat(pending, canonicalJsonString(pending.input));
  return Option.fromUndefinedOr(pending.challenge.split("\n").at(-1)).pipe(
    Option.filter((line) => line.startsWith("Responde exactamente: ")),
    Option.map((line) => line.slice("Responde exactamente: ".length)),
    Option.filter((command) => command.startsWith(commandPrefix)),
    Option.flatMap((command) =>
      Schema.decodeUnknownOption(ConfirmationDigest)(command.slice(commandPrefix.length)).pipe(
        Option.map((digest) => ({ command, digest }))
      )
    )
  );
};

const confirmationIsFresh = (pending: Readonly<PendingConfirmation>, now: DateTime.Utc): boolean =>
  DateTime.isLessThanOrEqualTo(
    now,
    DateTime.add(pending.issuedAt, { minutes: confirmationLifetimeMinutes })
  );

/**
 * Recovers at most one exact confirmation for a hosted turn and hides confirmation
 * digesting, replay prevention, and single-use consumption behind one decision.
 */
export const makeTurnConfirmation = Effect.fn("ToolConfirmation.makeTurn")(function* (
  userId: UserId,
  message: { readonly text: string }
) {
  const priorTranscript = yield* listRecentTranscriptEntries(userId, 1);
  const now = yield* DateTime.now;
  let submittedConfirmation = findPendingConfirmation(priorTranscript).pipe(
    Option.filter((pending) => confirmationIsFresh(pending, now)),
    Option.flatMap((pending) =>
      authorizationFromChallenge(pending).pipe(
        Option.filter(({ command }) => message.text.trim() === command),
        Option.map(({ digest }) => ({ ...pending, digest }))
      )
    )
  );

  const decide = Effect.fn("ToolConfirmation.decide")(function* ({
    binding,
    input,
  }: {
    readonly binding: Readonly<AgentOperationBinding>;
    readonly input: Schema.Json;
  }): Effect.fn.Return<ConfirmationDecision, never, Crypto.Crypto | SqlClient.SqlClient> {
    if (binding.policy.agentConfirmation === "not-required") {
      return { _tag: "Execute" };
    }
    if (
      Option.isSome(submittedConfirmation) &&
      matchesConfirmationSubject(submittedConfirmation.value, binding, input)
    ) {
      const submission: ConfirmationSubmission = submittedConfirmation.value;
      submittedConfirmation = Option.none();
      const consumed = yield* consumeConfirmation(userId, submission.digest, now);
      if (consumed) return { _tag: "Execute" };
    }

    const pending: ConfirmationSubject = {
      operation: binding.operation,
      input,
      issuedAt: yield* DateTime.now,
    };
    const { digest, serializedInput } = yield* confirmationBinding(pending);
    const challenge = confirmationChallenge(pending, digest, serializedInput);
    return {
      _tag: "RequireConfirmation",
      failure: ConfirmationRequiredFailure.make({
        code: "explicit_confirmation_required",
        message:
          "Use the exact host-rendered confirmation command, including its operation id and digest.",
        challenge,
      }),
    };
  });

  return { decide } as const;
});
