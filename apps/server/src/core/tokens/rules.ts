import { DateTime, Effect } from "effect";
import { PatIdleDuration } from "./model";
import type { ManualPATGrantInput, PATScopes } from "./model";

/** Computes a PAT's renewable idle deadline 90 days after creation or authenticated use. */
export const computePatIdleExpiry = (
  usedAt: DateTime.Utc
): Effect.Effect<DateTime.Utc, never, never> =>
  Effect.succeed(DateTime.addDuration(usedAt, PatIdleDuration));

/** Exact Spanish scope labels and descriptions shared by review and Consent disclosure. */
export const patScopeCopy: Record<
  PATScopes[number],
  Readonly<{ label: string; description: string }>
> = {
  read: {
    label: "Lectura",
    description: "Consultar tus datos financieros en Fidy.",
  },
  write: {
    label: "Escritura",
    description: "Crear y modificar tus datos financieros en Fidy.",
  },
  dashboard: {
    label: "Tablero",
    description: "Consultar y modificar tu tablero financiero en Fidy.",
  },
};

/** Builds the exact Spanish grant text reviewed for one normalized recipient and scope set. */
export const buildPATDisclosure = ({ recipientLabel, scopes }: ManualPATGrantInput): string =>
  `Nombre: “${recipientLabel}”.

Alcances autorizados:
${scopes.map((scope) => `- ${patScopeCopy[scope].label}: ${patScopeCopy[scope].description}`).join("\n")}

El PAT no tiene una fecha fija de vencimiento. Vence después de exactamente 90 días (2.160 horas) sin una autenticación exitosa. Cada uso autenticado exitoso reinicia ese plazo de inactividad. Puedes revocarlo desde la administración de PATs.

Fidy mostrará el PAT completo una sola vez en esta respuesta. Después conservará únicamente su resumen criptográfico; no podrá recuperar el valor original.`;
