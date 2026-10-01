/** Closed normalized phrases that explicitly authorize onboarding. */
export const acceptedReplies = new Set([
  "acepto",
  "si, acepto",
  "si acepto",
  "acepto el tratamiento de mis datos",
]);
/** Closed normalized phrases that explicitly refuse onboarding. */
export const declinedReplies = new Set(["no", "no acepto", "no autorizo", "rechazo"]);

/** Normalizes accents, spacing, case, and terminal punctuation without erasing internal punctuation. */
export const normalizeReply = (text: string): string =>
  text
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLocaleLowerCase("es-CO")
    .replaceAll(/[.!]+$/gu, "")
    .replaceAll(/\s+/gu, " ");
