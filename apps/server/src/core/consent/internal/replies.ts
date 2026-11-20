export const acceptedReplies = new Set([
  "acepto",
  "si, acepto",
  "si acepto",
  "acepto el tratamiento de mis datos",
]);

export const declinedReplies = new Set(["no", "no acepto", "no autorizo", "rechazo"]);

export const normalizeReply = (text: string): string =>
  text
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLocaleLowerCase("es-CO")
    .replaceAll(/[.!]+$/gu, "")
    .replaceAll(/\s+/gu, " ");
