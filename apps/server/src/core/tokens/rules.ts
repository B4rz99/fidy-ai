import { DateTime, Duration, Effect } from "effect";
import type { ManualPATGrantInput, PATLifetimeDays, PATScopes } from "./model";

/** Derives the one absolute PAT expiration from its issuance instant and reviewed lifetime. */
export const computePATExpiration = ({
  createdAt,
  lifetimeDays,
}: Readonly<{
  createdAt: DateTime.Utc;
  lifetimeDays: PATLifetimeDays;
}>): Effect.Effect<DateTime.Utc, never, never> =>
  Effect.succeed(DateTime.addDuration(createdAt, Duration.days(lifetimeDays)));

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

const hoursPerDay = 24;

const disclosureFor = (
  { recipientLabel, scopes, lifetimeDays }: ManualPATGrantInput,
  expiresAt: DateTime.Utc,
  delivery: string
): string => `Nombre: “${recipientLabel}”.

Alcances autorizados:
${scopes.map((scope) => `- ${patScopeCopy[scope].label}: ${patScopeCopy[scope].description}`).join("\n")}

Duración fija: ${lifetimeDays} días (${lifetimeDays * hoursPerDay} horas). Vencimiento exacto: ${DateTime.formatIso(expiresAt)}. El vencimiento no se extiende con el uso. Para obtener una fecha posterior debes crear un PAT de reemplazo. Puedes revocarlo antes desde la administración de PATs.

${delivery} Después conservará únicamente su resumen criptográfico; no podrá recuperar el valor original.`;

/** Builds the exact Spanish grant text reviewed for one normalized grant and fixed expiration. */
export const buildPATDisclosure = ({
  grant,
  expiresAt,
}: Readonly<{ grant: ManualPATGrantInput; expiresAt: DateTime.Utc }>): string =>
  disclosureFor(grant, expiresAt, "Fidy mostrará el PAT completo una sola vez en esta respuesta.");

/** Builds the distinct disclosure for direct delivery to the initiating User-owned client. */
export const buildPairedPATDisclosure = ({
  grant,
  expiresAt,
}: Readonly<{ grant: ManualPATGrantInput; expiresAt: DateTime.Utc }>): string =>
  disclosureFor(
    grant,
    expiresAt,
    "Fidy entregará el PAT completo una sola vez directamente al cliente que inició esta vinculación; este navegador no lo recibirá."
  );
