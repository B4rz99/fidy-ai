import { Effect, Redacted, Schema } from "effect";
import {
  RecoveryFailure,
  RecoveryInput,
  type RecoveryOperator,
  type RecoveryOutcome,
} from "./contract";

const messages: Readonly<Record<RecoveryOutcome, string>> = {
  approved:
    "Recuperación aprobada. Vuelve de inmediato al mismo navegador donde iniciaste la vinculación y continúa allí. No cierres esa pantalla ni compartas información adicional del navegador con soporte.\n",
  not_approved:
    "No pudimos aprobar la recuperación. La información proporcionada o la vinculación no permiten continuar. Si aún conservas tu código de recuperación, inicia una nueva vinculación y vuelve a contactar a soporte. No envíes documentos, datos financieros ni números de tarjeta o cuenta.\n",
  unavailable:
    "La operación de soporte no está disponible. No se tomó una decisión de recuperación. Escala el incidente por el canal interno.\n",
  uncertain:
    "No se puede confirmar el resultado de la recuperación; el servidor puede haber aprobado y consumido el código. No repitas la solicitud. Vuelve al mismo navegador para comprobar y completar la vinculación; si no puedes continuar, escala el incidente sin compartir secretos.\n",
};
const localMessages: Readonly<Record<RecoveryFailure["reason"], string>> = {
  InvalidInput:
    "Usa fidy support-recovery sin argumentos ni --json, en una terminal interactiva. Introduce solo la referencia pública y el código de recuperación en los prompts; no uses archivos, stdin canalizado ni variables de entorno.\n",
  AccessUnavailable:
    "No se pudo autenticar al operador. Instala cloudflared y completa Cloudflare Access en el navegador. No se envió una solicitud de recuperación.\n",
  Cancelled: "Entrada cancelada. No se envió una solicitud de recuperación.\n",
};

const discardProof = (proof: Redacted.Redacted<string>): Effect.Effect<void> =>
  Effect.sync(() => {
    Redacted.wipeUnsafe(proof);
  });

/** Submits one support decision. True means failure; uncertain decisions are never replayed. */
export const runSupportRecovery = Effect.fn(function* (
  args: ReadonlyArray<string>,
  operator: RecoveryOperator
) {
  return yield* Effect.gen(function* () {
    if (!operator.interactive || args.length !== 1 || args[0] !== "support-recovery") {
      return yield* new RecoveryFailure({ reason: "InvalidInput" });
    }
    yield* operator.write(
      "Completa Cloudflare Access en el navegador como operador de recuperación.\n"
    );
    const assertion = yield* operator.authenticate;
    yield* Effect.addFinalizer(() => discardProof(assertion));
    const pairingCode = yield* Schema.decodeEffect(RecoveryInput.fields.pairingCode)(
      yield* operator.readPairing
    ).pipe(Effect.mapError(() => new RecoveryFailure({ reason: "InvalidInput" })));
    const code = yield* operator.readCode;
    yield* Effect.addFinalizer(() => discardProof(code));
    const input = yield* Schema.decodeEffect(RecoveryInput)({
      pairingCode,
      backupRecoveryCode: Redacted.value(code),
    }).pipe(Effect.mapError(() => new RecoveryFailure({ reason: "InvalidInput" })));
    yield* Effect.addFinalizer(() => discardProof(input.backupRecoveryCode));
    const outcome = yield* operator
      .submit(input, assertion)
      .pipe(Effect.onInterrupt(() => operator.write(messages.uncertain)));
    yield* operator.write(messages[outcome]);
    return outcome !== "approved";
  }).pipe(
    Effect.scoped,
    Effect.catchTag("RecoveryFailure", (failure) =>
      operator.write(localMessages[failure.reason]).pipe(Effect.as(true))
    )
  );
});
