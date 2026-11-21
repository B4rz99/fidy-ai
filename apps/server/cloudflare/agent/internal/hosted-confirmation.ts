import { TranscriptText } from "../../../src/core/agent/contract";

const nonceBytes = 32;

const commandPrefix = "CONFIRMAR ";

const modelCommand = new RegExp(`\\b${commandPrefix}[a-f0-9]{${nonceBytes * 2}}\\b`, "iu");

export const guardModelConfirmationReply = (text: TranscriptText): TranscriptText =>
  modelCommand.test(text)
    ? TranscriptText.make(
        "No pude preparar esos cambios. Vuelve a pedirlos para revisarlos antes de confirmar."
      )
    : text;

export const isHostedConfirmationAttempt = (text: TranscriptText): boolean =>
  text.startsWith(commandPrefix);
