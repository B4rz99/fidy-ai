import { Effect, Option, Schema } from "effect";
import { type CanonicalToolEvidence, TranscriptText } from "../../../src/core/agent/contract";
import { CanonicalOperationId } from "../../../src/core/canonical-operations/contract";
import { SubscriptionStatus } from "../../../src/core/subscription/contract";
import { AtomicBatchAdmission, atomicBatchOperation } from "../../../src/shell/operations/contract";
import type { ConfirmationRead } from "./confirmation-description";

type CancellationReview =
  | Readonly<{ _tag: "Ready" }>
  | Readonly<{ _tag: "Notice"; text: TranscriptText }>;
const cancellationOperation = "subscription.cancelSubscription";
const includesCancellation = (operation: string, input: CanonicalToolEvidence): boolean => {
  if (operation === cancellationOperation) return true;
  if (operation !== atomicBatchOperation) return false;
  const batch = Schema.decodeUnknownOption(AtomicBatchAdmission)(input);
  return (
    Option.isSome(batch) &&
    batch.value.payload.calls.some((raw) => {
      const call = Schema.decodeUnknownOption(Schema.Struct({ operation: Schema.String }))(raw);
      return Option.isSome(call) && call.value.operation === cancellationOperation;
    })
  );
};
const cancellationNotice = (status: SubscriptionStatus): Option.Option<string> => {
  if (Option.isSome(status.cancellation)) {
    return Option.some("La renovación de tu suscripción ya está cancelada.");
  }
  return Option.isNone(status.paidSubscription)
    ? Option.some("No tienes una suscripción de pago que cancelar.")
    : Option.none();
};
export const reviewCancellation = ({
  operation,
  input,
  read,
}: Readonly<{
  operation: string;
  input: CanonicalToolEvidence;
  read: ConfirmationRead;
}>): Effect.Effect<CancellationReview> =>
  Effect.gen(function* () {
    if (!includesCancellation(operation, input)) return { _tag: "Ready" };
    const observed = yield* read(
      CanonicalOperationId.make("subscription.getSubscriptionStatus"),
      {}
    );
    const status = Option.flatMap(
      observed,
      Schema.decodeUnknownOption(Schema.Struct({ data: Schema.toCodecJson(SubscriptionStatus) }))
    );
    if (Option.isNone(status)) {
      return {
        _tag: "Notice",
        text: TranscriptText.make("No pude consultar tu suscripción. Inténtalo de nuevo."),
      };
    }
    const text = cancellationNotice(status.value.data);
    return Option.match(text, {
      onNone: (): CancellationReview => ({ _tag: "Ready" }),
      onSome: (notice): CancellationReview => ({
        _tag: "Notice",
        text: TranscriptText.make(
          notice + (operation === atomicBatchOperation ? " No apliqué ningún cambio." : "")
        ),
      }),
    });
  });
