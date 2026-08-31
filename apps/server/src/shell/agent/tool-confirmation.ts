import { Crypto, DateTime, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ProviderQualifiedMessages } from "~/core/consent/model";
import type { UserId } from "~/core/identity/reference";
import { type TranscriptEntry, TranscriptText } from "~/core/transcript/model";
import {
  type AtomicBatchInput,
  atomicBatchOperation,
  getAtomicBatchInputSchema,
} from "~/shell/operations/operations";
import {
  ConfirmationDigest,
  type ConfirmationDigest as ConfirmationDigestType,
  type ConfirmationPermit,
  confirmationCommandFromChallenge,
  renderConfirmationChallengeText,
} from "./tool-confirmation-model";
import { canonicalJsonString } from "./canonical-json";
import { consumeConfirmation } from "./tool-confirmation-repo";
import type { AgentOperationBinding } from "./agent-operation-binding";

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
type ConfirmationSubmission = PendingConfirmation &
  Readonly<{
    digest: ConfirmationDigestType;
    evidence: Option.Option<ProviderQualifiedMessages>;
  }>;

export type { ConfirmationPermit } from "./tool-confirmation-model";

type ConfirmationDecision =
  | { readonly _tag: "Execute"; readonly permit: ConfirmationPermit }
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

const confirmationBinding = Effect.fn(function* (pending: Readonly<ConfirmationSubject>) {
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
    renderConfirmationChallengeText({
      challengeBody: format.challengeBody,
      commandPrefix: format.commandPrefix,
      digest,
    })
  );
};

const authorizationFromChallenge = (
  pending: Readonly<PendingConfirmation>
): Option.Option<Readonly<{ command: string; digest: ConfirmationDigestType }>> => {
  const { commandPrefix } = confirmationFormat(pending, canonicalJsonString(pending.input));
  return confirmationCommandFromChallenge(pending.challenge).pipe(
    Option.filter((command) => command.startsWith(commandPrefix)),
    Option.flatMap((command) =>
      Schema.decodeOption(ConfirmationDigest)(command.slice(commandPrefix.length)).pipe(
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

const permitMatches = (input: {
  readonly expectedBinding: Readonly<AgentOperationBinding>;
  readonly expectedInput: Schema.Json;
  readonly attemptedBinding: Readonly<AgentOperationBinding>;
  readonly attemptedInput: Schema.Json;
}): boolean =>
  input.attemptedBinding.operation === input.expectedBinding.operation &&
  canonicalJsonString(input.attemptedInput) === canonicalJsonString(input.expectedInput);

/** Single-use permit for a call needing no confirmation: it grants exactly this binding and input. */
export const immediatePermit = ({
  binding,
  input,
}: Readonly<{
  binding: Readonly<AgentOperationBinding>;
  input: Schema.Json;
}>): ConfirmationPermit => {
  let active = true;
  return {
    consume: ({ binding: attemptedBinding, canonicalInput }) =>
      Effect.sync(() => {
        if (
          !active ||
          !permitMatches({
            expectedBinding: binding,
            expectedInput: input,
            attemptedBinding,
            attemptedInput: canonicalInput,
          })
        ) {
          return { confirmed: false, evidence: Option.none() };
        }
        active = false;
        return { confirmed: true, evidence: Option.none() };
      }),
  };
};

const submittedPermit = (input: {
  readonly userId: UserId;
  readonly binding: Readonly<AgentOperationBinding>;
  readonly canonicalInput: Schema.Json;
  readonly submission: ConfirmationSubmission;
  readonly now: DateTime.Utc;
}): ConfirmationPermit => {
  const { binding, canonicalInput: expectedInput, now, submission, userId } = input;
  let active = true;
  return {
    consume: ({ binding: attemptedBinding, canonicalInput: attemptedInput }) => {
      if (
        !active ||
        !permitMatches({
          expectedBinding: binding,
          expectedInput,
          attemptedBinding,
          attemptedInput,
        })
      ) {
        return Effect.succeed({ confirmed: false, evidence: Option.none() });
      }
      active = false;
      return consumeConfirmation(userId, submission.digest, now).pipe(
        Effect.map((confirmed) => ({
          confirmed,
          evidence: confirmed ? submission.evidence : Option.none(),
        }))
      );
    },
  };
};

type SubmittedConfirmationState = {
  value: Option.Option<ConfirmationSubmission>;
};

const decideConfirmation = Effect.fn("ToolConfirmation.decide")(function* (input: {
  readonly userId: UserId;
  readonly now: DateTime.Utc;
  readonly submitted: SubmittedConfirmationState;
  readonly binding: Readonly<AgentOperationBinding>;
  readonly canonicalInput: Schema.Json;
}): Effect.fn.Return<ConfirmationDecision, never, Crypto.Crypto | SqlClient.SqlClient> {
  const { binding, canonicalInput, now, submitted, userId } = input;
  if (binding.policy.agentConfirmation === "not-required") {
    return { _tag: "Execute", permit: immediatePermit({ binding, input: canonicalInput }) };
  }
  if (
    Option.isSome(submitted.value) &&
    matchesConfirmationSubject(submitted.value.value, binding, canonicalInput)
  ) {
    const submission = submitted.value.value;
    submitted.value = Option.none();
    return {
      _tag: "Execute",
      permit: submittedPermit({ userId, binding, canonicalInput, submission, now }),
    };
  }
  const pending: ConfirmationSubject = {
    operation: binding.operation,
    input: canonicalInput,
    issuedAt: yield* DateTime.now,
  };
  const { digest, serializedInput } = yield* confirmationBinding(pending);
  return {
    _tag: "RequireConfirmation",
    failure: ConfirmationRequiredFailure.make({
      code: "explicit_confirmation_required",
      message:
        "Use the exact host-rendered confirmation command, including its operation id and digest.",
      challenge: confirmationChallenge(pending, digest, serializedInput),
    }),
  };
});

/**
 * Recovers at most one exact confirmation for a hosted turn and hides confirmation
 * digesting, replay prevention, and single-use consumption behind one decision. The runtime supplies
 * the session's own recent Transcript, so a challenge issued under a closed session's Consent basis
 * is never consumable under the basis that replaced it.
 */
export const makeTurnConfirmation = Effect.fn("ToolConfirmation.makeTurn")(function* (
  userId: UserId,
  priorTranscript: ReadonlyArray<TranscriptEntry>,
  message: {
    readonly text: string;
    readonly confirmationEvidence: Option.Option<ProviderQualifiedMessages>;
  }
) {
  const now = yield* DateTime.now;
  const submitted: SubmittedConfirmationState = {
    value: findPendingConfirmation(priorTranscript).pipe(
      Option.filter((pending) => confirmationIsFresh(pending, now)),
      Option.flatMap((pending) =>
        authorizationFromChallenge(pending).pipe(
          Option.filter(({ command }) => message.text.trim() === command),
          Option.map(({ digest }) => ({
            ...pending,
            digest,
            evidence: message.confirmationEvidence,
          }))
        )
      )
    ),
  };

  return {
    decide: ({
      binding,
      input,
    }: {
      readonly binding: AgentOperationBinding;
      readonly input: Schema.Json;
    }) => decideConfirmation({ userId, now, submitted, binding, canonicalInput: input }),
  } as const;
});
