import { Crypto, Effect, Option, Schema } from "effect";
import type { UserId } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import type { TranscriptWindowEntry } from "~/core/transcript/rules";
import { listRecentTranscriptEntries } from "~/shell/transcript/transcript-service";
import type { AgentOperationBinding } from "./toolkit";

const hexadecimalRadix = 16;

const ConfirmationRequiredFailure = Schema.Struct({
  code: Schema.Literal("explicit_confirmation_required"),
  message: Schema.Literal(
    "Use the exact host-rendered confirmation command, including its operation id and digest."
  ),
  challenge: TranscriptText,
});
type ConfirmationRequiredFailure = typeof ConfirmationRequiredFailure.Type;

const ConfirmationDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("ConfirmationDigest")
);
type ConfirmationDigest = typeof ConfirmationDigest.Type;

type PendingApproval = Pick<
  Extract<TranscriptWindowEntry, { readonly _tag: "CanonicalToolCallEntry" }>,
  "operation" | "input"
>;

type ConfirmationDecision =
  | { readonly _tag: "Execute" }
  | {
      readonly _tag: "RequireConfirmation";
      readonly failure: ConfirmationRequiredFailure;
    };

type WindowCallEntry = Extract<TranscriptWindowEntry, { readonly _tag: "CanonicalToolCallEntry" }>;
type WindowResultEntry = Extract<
  TranscriptWindowEntry,
  { readonly _tag: "CanonicalToolResultEntry" }
>;

const resultEntryAt = (
  entries: ReadonlyArray<TranscriptWindowEntry>,
  index: number
): Option.Option<WindowResultEntry> =>
  Option.fromUndefinedOr(entries[index]).pipe(
    Option.filter((entry): entry is WindowResultEntry => entry._tag === "CanonicalToolResultEntry")
  );

const callEntryAt = (
  entries: ReadonlyArray<TranscriptWindowEntry>,
  index: number
): Option.Option<WindowCallEntry> =>
  Option.fromUndefinedOr(entries[index]).pipe(
    Option.filter((entry): entry is WindowCallEntry => entry._tag === "CanonicalToolCallEntry")
  );

const confirmationFailure = (
  result: WindowResultEntry,
  challenge: string
): Option.Option<ConfirmationRequiredFailure> =>
  result.outcome._tag === "ToolInputRejected"
    ? Option.some(result.outcome.failure).pipe(
        Option.filter(Schema.is(ConfirmationRequiredFailure)),
        Option.filter((failure) => failure.challenge === challenge)
      )
    : Option.none();

const pendingApprovalAt = (
  entries: ReadonlyArray<TranscriptWindowEntry>,
  resultIndex: number,
  challenge: string
): Option.Option<PendingApproval> =>
  Option.gen(function* () {
    const result = yield* resultEntryAt(entries, resultIndex);
    yield* confirmationFailure(result, challenge);
    const call = yield* callEntryAt(entries, resultIndex - 1);
    yield* Option.some(call).pipe(
      Option.filter((candidate) => candidate.toolCallId === result.toolCallId)
    );
    return { operation: call.operation, input: call.input };
  });

const findPendingApproval = (
  entries: ReadonlyArray<TranscriptWindowEntry>
): Option.Option<PendingApproval> => {
  const assistant = entries.at(-1);
  if (assistant?._tag !== "AssistantTranscriptEntry") return Option.none();

  for (let index = entries.length - 1; index > 0; index -= 1) {
    const pending = pendingApprovalAt(entries, index, assistant.text);
    if (Option.isSome(pending)) return pending;
  }
  return Option.none();
};

const matchesApprovedCall = (
  pending: Readonly<PendingApproval>,
  binding: Readonly<AgentOperationBinding>,
  input: unknown
): boolean =>
  pending.operation === binding.operation &&
  JSON.stringify(pending.input) === JSON.stringify(input);

const confirmationCommand = (
  pending: Readonly<PendingApproval>,
  digest: ConfirmationDigest
): string => `CONFIRMAR ${pending.operation} ${digest}`;

const approvalBinding = Effect.fn("ToolConfirmation.approvalBinding")(function* (
  pending: Readonly<PendingApproval>
) {
  const crypto = yield* Crypto.Crypto;
  const serializedInput = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
    pending.input
  ).pipe(Effect.orDie);
  const payload = new TextEncoder().encode(`${pending.operation}\n${serializedInput}`);
  const bytes = yield* crypto.digest("SHA-256", payload).pipe(Effect.orDie);
  const digest = ConfirmationDigest.make(
    Array.from(bytes, (byte) => byte.toString(hexadecimalRadix).padStart(2, "0")).join("")
  );
  return { digest, serializedInput };
});

const confirmationChallenge = (
  pending: Readonly<PendingApproval>,
  digest: ConfirmationDigest,
  serializedInput: string
): TranscriptText =>
  TranscriptText.make(
    `Esta operación requiere confirmación.\n` +
      `Operación exacta: ${pending.operation}\n` +
      `Argumentos exactos: ${serializedInput}\n` +
      `Responde exactamente: ${confirmationCommand(pending, digest)}`
  );

/**
 * Recovers at most one exact approval for a hosted turn and hides confirmation
 * digesting, replay prevention, and single-use consumption behind one decision.
 */
export const makeTurnConfirmation = Effect.fn("ToolConfirmation.makeTurn")(function* (
  userId: UserId,
  message: { readonly text: string }
) {
  const priorTranscript = yield* listRecentTranscriptEntries(userId, 1);
  let approvedCall = yield* findPendingApproval(priorTranscript).pipe(
    Option.match({
      onNone: () => Effect.succeed(Option.none()),
      onSome: (pending) =>
        approvalBinding(pending).pipe(
          Effect.map(({ digest }) =>
            message.text.trim() === confirmationCommand(pending, digest)
              ? Option.some(pending)
              : Option.none()
          )
        ),
    })
  );

  const decide = Effect.fn("ToolConfirmation.decide")(function* ({
    binding,
    input,
  }: {
    readonly binding: Readonly<AgentOperationBinding>;
    readonly input: Schema.Json;
  }): Effect.fn.Return<ConfirmationDecision, never, Crypto.Crypto> {
    if (binding.policy.agentConfirmation === "not-required") {
      return { _tag: "Execute" };
    }
    if (Option.isSome(approvedCall) && matchesApprovedCall(approvedCall.value, binding, input)) {
      approvedCall = Option.none();
      return { _tag: "Execute" };
    }

    const pending = { operation: binding.operation, input };
    const { digest, serializedInput } = yield* approvalBinding(pending);
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
